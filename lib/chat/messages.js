// Fast path for user chat. Order: authenticate (router) -> validate -> room access -> idempotency ->
// pre-publication safety gate -> one transaction (atomic per-user message limiter, sequence number, insert, event log,
// durable follow-up jobs) -> wake listeners. No AI call happens on this path.
import { config } from '../config.js';
import { one } from '../db/index.js';
import { HttpError, badRequest, cleanText, onlyKeys, requireId, newId, secondsUntil } from '../util.js';
import { roomAccess } from '../rooms/service.js';
import { nextSeq, appendEvent, RoomEndedError } from '../rooms/events.js';
import { classify } from '../moderation/classifier.js';
import { recordModeration, recentStrikes } from '../moderation/audit.js';
import { enqueue } from '../jobs/queue.js';
import { notifyRoom } from '../realtime/bus.js';
import { hydrateMessages } from './hydrate.js';
import { threadForMessage, maybeOpenDiscussion, touchThread } from '../rooms/threads.js';
import { fixtureForMatch } from '../match/fixture.js';

const QUESTION_START = /^(?:what|who|why|how|when|which|will|can|could|should|is|are|does|did|kya|kaun|kyun|kyu|kaise|kab|kitne|kitna|kitni|konsa|kaunsa|kahan)\b/i;

export const mentionsCohost = (text) => /(^|\s)@huddle\b/i.test(text);

// A question about this room's game: its rules, players or what is happening (each sport lists its terms).
export function isSportQuestion(text, fixture) {
  const t = text.trim();
  return Boolean(fixture) && (t.includes('?') || QUESTION_START.test(t)) && fixture.terms.test(t);
}

const cooldownError = (until) => {
  const retry = Math.max(1, secondsUntil(until));
  return new HttpError(429, 'cooldown', `You can send your next message in ${retry}s.`, { retry_after: retry, cooldown_until: until });
};

export async function sendMessage(db, user, roomId, body) {
  const cfg = config();
  onlyKeys(body, ['client_msg_id', 'text', 'reply_to', 'thread_id']);
  if (typeof body.client_msg_id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.client_msg_id)) throw badRequest('client_msg_id is required.', 'invalid_client_msg_id');
  const text = cleanText(body.text, { max: cfg.chat.maxLength, field: 'Message' });
  const replyTo = body.reply_to == null ? null : requireId(body.reply_to, 'msg', 'reply_to');

  const { room, policy } = await roomAccess(db, roomId, user);

  // A retried request returns the original message instead of posting twice.
  const existing = await one(db,
    `SELECT id, status FROM messages WHERE room_id = $1 AND sender_id = $2 AND client_msg_id = $3 AND sender_type = 'user'`,
    [roomId, user.id, body.client_msg_id]);
  if (existing) {
    const msg = (await hydrateMessages(db, roomId, [existing.id], user.id)).get(existing.id);
    return { message: msg, status: existing.status, duplicate: true };
  }

  const strikes = await recentStrikes(db, user.id);
  if (strikes.n >= 3) {
    const until = new Date(new Date(strikes.last_at).getTime() + 2 * 60 * 1000);
    if (until > new Date()) {
      throw new HttpError(429, 'moderation_pause', 'Several of your messages were stopped, so posting is paused for a couple of minutes.', { retry_after: secondsUntil(until) });
    }
  }
  const pending = await one(db, 'SELECT next_allowed_at FROM user_send_cooldowns WHERE user_id = $1 AND next_allowed_at > now()', [user.id]);
  if (pending) throw cooldownError(pending.next_allowed_at);

  // Pre-publication safety gate. Rejected messages are never stored and do not use up the cooldown.
  const decision = classify(text, { level: policy.level });
  if (decision.action === 'reject') {
    const eventId = await recordModeration(db, {
      roomId, targetUserId: user.id, eventType: 'message_rejected', severity: decision.risk,
      categories: decision.categories, level: policy.level, action: 'rejected',
    });
    throw new HttpError(422, 'message_rejected', decision.reason, { categories: decision.categories, moderation_event_id: eventId, level: policy.level });
  }

  const fixture = await fixtureForMatch(db, room.match_id);
  const mention = mentionsCohost(text);
  const question = mention || isSportQuestion(text, fixture);
  const held = decision.action === 'hold';
  // The match moment the message was sent at, so a question is answered about the game as it stood then.
  const matchSeq = room.match_id
    ? (await one(db, 'SELECT max(seq)::int AS seq FROM match_events WHERE match_id = $1', [room.match_id]))?.seq ?? null : null;

  const out = await db.tx(async (q) => {
    // The rule: one accepted message per user every chat.cooldownSeconds (10 s), across every room, tab and device.
    // Atomic compare-and-set on one row per user; concurrent sends cannot both pass.
    const cd = await one(q,
      `INSERT INTO user_send_cooldowns (user_id, next_allowed_at) VALUES ($1, now() + make_interval(secs => $2))
       ON CONFLICT (user_id) DO UPDATE SET next_allowed_at = EXCLUDED.next_allowed_at
       WHERE user_send_cooldowns.next_allowed_at <= now()
       RETURNING next_allowed_at`,
      [user.id, cfg.chat.cooldownSeconds]);
    if (!cd) {
      const cur = await one(q, 'SELECT next_allowed_at FROM user_send_cooldowns WHERE user_id = $1', [user.id]);
      throw cooldownError(cur.next_allowed_at);
    }
    let reply = null;
    if (replyTo) {
      reply = await one(q, `SELECT id, sender_id, sender_type FROM messages WHERE id = $1 AND room_id = $2 AND status = 'visible'`, [replyTo, roomId]);
      if (!reply) throw badRequest('That message is no longer available.', 'reply_unavailable');
    }
    const id = newId('msg');
    const threadId = await threadForMessage(q, roomId, text, body.thread_id);
    let seq = null;
    if (held) {
      const live = await one(q, `SELECT id FROM rooms WHERE id = $1 AND status = 'active' FOR UPDATE`, [roomId]);
      if (!live) throw new RoomEndedError();
    } else {
      seq = await nextSeq(q, roomId);
    }
    await q.query(
      `INSERT INTO messages (id, room_id, seq, sender_type, sender_id, client_msg_id, body, reply_to_id, status, is_question, answer_state, moderation, thread_id, match_seq)
       VALUES ($1, $2, $3, 'user', $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)`,
      [id, roomId, seq, user.id, body.client_msg_id, text, replyTo, held ? 'held' : 'visible', question,
        question && room.ai_enabled && !held ? 'pending' : null,
        JSON.stringify({ action: decision.action, risk: decision.risk, categories: decision.categories, level: policy.level, policy_version: decision.policy_version }),
        threadId, matchSeq]);
    if (held) {
      await recordModeration(q, { roomId, targetUserId: user.id, messageId: id, eventType: 'message_held', severity: decision.risk, categories: decision.categories, level: policy.level, action: 'held' });
      return { id, seq, cooldownUntil: cd.next_allowed_at };
    }
    await appendEvent(q, roomId, 'message', id, seq);
    if (threadId) await touchThread(q, threadId);
    else await maybeOpenDiscussion(q, roomId, text, fixture?.topics);
    if (decision.action === 'flag') {
      await recordModeration(q, { roomId, targetUserId: user.id, messageId: id, eventType: 'message_flagged', severity: decision.risk, categories: decision.categories, level: policy.level, action: 'flagged' });
    }
    // A human answer wins the race against a delayed AI answer (compare-and-set on the question).
    if (reply && reply.sender_type === 'user' && reply.sender_id !== user.id) {
      await q.query(`UPDATE messages SET answer_state = 'human' WHERE id = $1 AND answer_state = 'pending'`, [reply.id]);
    }
    const handles = [...text.matchAll(/@([a-z0-9_]{3,20})\b/gi)].map((m) => m[1].toLowerCase()).filter((h) => h !== 'huddle');
    if (handles.length) {
      await q.query(
        `UPDATE messages m SET answer_state = 'human' FROM users u
          WHERE m.room_id = $1 AND m.sender_id = u.id AND u.id <> $2 AND m.answer_state = 'pending'
            AND m.created_at > now() - interval '5 minutes'
            AND u.handle IN (SELECT jsonb_array_elements_text($3::jsonb))`,
        [roomId, user.id, JSON.stringify(handles)]);
    }
    // Durable follow-up work, committed with the message: AI answers and the quiet-room check.
    if (room.ai_enabled) {
      if (mention) {
        await enqueue(q, { type: 'ai_answer', roomId, dedupeKey: `answer:${id}`, payload: { message_id: id, mode: 'mention' }, priority: 1, expiresInSeconds: 120, maxAttempts: 2 });
      } else if (question) {
        const delay = cfg.cohost.unansweredDelaySeconds;
        await enqueue(q, { type: 'ai_answer', roomId, dedupeKey: `answer:${id}`, payload: { message_id: id, mode: 'unanswered' }, delaySeconds: delay, priority: 2, expiresInSeconds: delay + 120, maxAttempts: 2 });
      }
      await enqueue(q, { type: 'continuity_check', roomId, dedupeKey: `continuity:${roomId}`, payload: { room_id: roomId }, delaySeconds: cfg.cohost.quietMinutes * 60, priority: 7, reschedule: true });
    }
    return { id, seq, cooldownUntil: cd.next_allowed_at };
  });

  if (!held) notifyRoom(roomId);
  const msg = (await hydrateMessages(db, roomId, [out.id], user.id, fixture?.sport ?? null)).get(out.id);
  return {
    message: msg,
    status: held ? 'held' : 'visible',
    cooldown_until: out.cooldownUntil,
    notice: held ? decision.reason : mention && !room.ai_enabled ? 'The AI Co-host is switched off in this room.' : null,
  };
}
