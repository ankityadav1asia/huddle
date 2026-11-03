// The AI Co-host: answers to questions nobody answered, quiet-room polls, match momentum explanations and Catch Me
// Up (its private Q&A, the Dream Bot, is in bot.ts). Each re-checks room state and membership before publishing, and
// never publishes unchecked output.
import { config } from '../config.ts';
import { one, many, type Db } from '../db/index.ts';
import type { JobRow, MatchRow, MessageRow, PollRow, RoomEventRow, RoomRow, SignalRow } from '../db/rows.ts';
import type { SessionUser } from '../auth/sessions.ts';
import { HttpError, badRequest, conflict, onlyKeys, clamp, newId, errorCode, type RequestBody } from '../util.ts';
import { log } from '../log.ts';
import { ai } from '../ai/index.ts';
import { SYSTEM, SCHEMAS, buildPrompt, validateOutput, allowedNumbersFrom } from '../ai/tasks.ts';
import { roomAccess, type MemberStatus } from '../rooms/service.ts';
import { nextSeq, appendEvent, RoomEndedError } from '../rooms/events.ts';
import { notifyRoom } from '../realtime/bus.ts';
import { takeToken } from '../limits.ts';
import { createPoll } from '../chat/polls.ts';
import { matchContext, askedContext, roomMessages, eventsSince, publishedSignalsSince } from './context.ts';
import { matchState } from '../match/feed.ts';
import { fixtureFor } from '../match/fixture.ts';
import { recordModeration } from '../moderation/audit.ts';
import { cached } from '../ai/context-cache.ts';

const AI_LABEL = 'AI Co-host';

// Jobs as the handlers read them (payloads hold ids only; lib/chat/messages.ts and lib/match/feed.ts queue them).
type AnswerJob = Pick<JobRow, 'room_id'> & { payload: { message_id: string } };
type MomentumJob = { payload: { signal_id: string } };
// The claimed question: a member's message, so it always has a sender and text.
type Question = Pick<MessageRow, 'id' | 'room_id' | 'seq' | 'thread_id' | 'match_seq'> & { sender_id: string; body: string };
// A poll as Catch Me Up summarises it: counts maps option index to votes, null before the first vote.
type PollSummary = Pick<PollRow, 'question' | 'options' | 'status'> & { counts: Record<string, number> | null };
// A fresh poll for a quiet room: AI-written, or the sport's template when the AI is off or fails.
interface PollIdea { question: string; options: string[]; source: string }

// The AI budgets: AI_ROOM_REQUESTS_PER_10_MIN per room and AI_USER_REQUESTS_PER_5_MIN per person.
export const roomAiToken = (db: Db, roomId: string) => takeToken(db, `ai_room:${roomId}`, { limit: config().cohost.roomAiPer10Min, windowSeconds: 600 });
export const userAiToken = (db: Db, userId: string) => takeToken(db, `ai_user:${userId}`, { limit: config().cohost.userAiPer5Min, windowSeconds: 300 });

async function aiBudget(db: Db, room: Pick<RoomRow, 'id'>, userId: string | null) {
  if (!(await roomAiToken(db, room.id)).ok) return false;
  return !userId || (await userAiToken(db, userId)).ok;
}

export async function handleAnswerJob(db: Db, job: AnswerJob) {
  const { message_id: messageId } = job.payload;
  // Compare-and-set: only one path (a human reply or this job) can win the question.
  const q = await one<Question>(db,
    `UPDATE messages SET answer_state = 'ai_claimed' WHERE id = $1 AND room_id = $2 AND answer_state = 'pending'
     RETURNING id, room_id, sender_id, body, seq, thread_id, match_seq`, [messageId, job.room_id]);
  if (!q) return 'cancelled';
  const room = await one<RoomRow>(db, 'SELECT * FROM rooms WHERE id = $1', [q.room_id]);
  const asker = await one<{ status: MemberStatus }>(db, `SELECT status FROM room_members WHERE room_id = $1 AND user_id = $2`, [q.room_id, q.sender_id]);
  // Nobody asked the Co-host by name, so an answer it cannot give is dropped quietly.
  const giveUp = async () => {
    await db.query(`UPDATE messages SET answer_state = 'cancelled' WHERE id = $1 AND answer_state = 'ai_claimed'`, [q.id]);
    return 'cancelled';
  };
  if (!room || room.status !== 'active' || !room.ai_enabled || asker?.status !== 'active') return giveUp();
  if (!(await aiBudget(db, room, null))) return giveUp();

  const orchestrator = await ai();
  const mc = await matchContext(db, room);
  const asked = await askedContext(db, room, q.match_seq);
  const recent = await roomMessages(db, room.id, { limit: 12 });
  const grounding = {
    allowedEventIds: new Set<string>([...mc.allowedEventIds, ...(asked?.eventIds || [])]),
    allowedNumbers: new Set<string>([...mc.allowedNumbers, ...allowedNumbersFrom(asked?.rules, asked?.roster, asked?.whenAsked)]),
  };
  const result = await orchestrator.run({
    task: 'answer', system: SYSTEM, schema: SCHEMAS.answer, roomId: room.id, userId: q.sender_id,
    user: buildPrompt('answer', {
      SPORT: asked?.sport, MATCH_WHEN_ASKED: asked?.whenAsked || undefined,
      VERIFIED_MATCH_DATA: mc.facts, COMMENTARY: mc.commentary, DATA_FRESHNESS: mc.freshness,
      RULES_SHEET: asked?.rules, ROSTER: asked?.roster,
      ROOM_MESSAGES_UNTRUSTED: recent.filter((m) => m.message_id !== q.id).map(({ from, text }) => ({ from, text })),
      QUESTION_UNTRUSTED: q.body,
    }),
    validate: (v) => validateOutput('answer', v, grounding),
    isCancelled: async () => (await one<Pick<RoomRow, 'status'>>(db, `SELECT status FROM rooms WHERE id = $1`, [room.id]))?.status !== 'active',
  });
  if (!result.ok) {
    log.info('cohost.answer_unavailable', { room: room.id, category: result.category });
    await recordBlockedOutput(db, room.id, result.reason);
    return giveUp();
  }
  const v = result.value;
  const meta = {
    label: AI_LABEL, kind: 'answer', type: v.type, confidence: v.confidence, language: v.language,
    grounding: { status: v.grounding.status, source_event_ids: v.grounding.sourceEventIds, data_as_of: mc.freshness?.latest_verified_update || null, stale: Boolean(mc.freshness?.stale), source: 'demo_fixture' },
    asked_at: asked?.whenAsked?.at || null, // the match clock when the question was asked
    provider: result.provider, model: result.model, fallback_used: result.fallbackUsed,
  };
  // Idempotent publication: the client key is derived from the question, so a re-run cannot post twice.
  const published = await db.tx(async (t) => {
    const claim = await one<Pick<MessageRow, 'id'>>(t, `UPDATE messages SET answer_state = 'ai_answered' WHERE id = $1 AND answer_state = 'ai_claimed' RETURNING id`, [q.id]);
    if (!claim) return null;
    const seq = await nextSeq(t, room.id);
    const row = await one<Pick<MessageRow, 'id'>>(t,
      `INSERT INTO messages (id, room_id, seq, sender_type, sender_id, client_msg_id, body, reply_to_id, status, ai_meta, thread_id)
       VALUES ($1, $2, $3, 'ai', NULL, $4, $5, $6, 'visible', $7::jsonb, $8)
       ON CONFLICT (room_id, client_msg_id) WHERE sender_type = 'ai' DO NOTHING RETURNING id`,
      [newId('msg'), room.id, seq, `ai:answer:${q.id}`, v.text, q.id, JSON.stringify(meta), q.thread_id]);
    if (!row) return null;
    await appendEvent(t, room.id, 'message', row.id, seq);
    await appendEvent(t, room.id, 'message_update', q.id);
    return row.id;
  }).catch((err: unknown) => { if (err instanceof RoomEndedError) return null; throw err; });
  if (!published) return 'discarded';
  notifyRoom(room.id);
  return 'published';
}

// Unsafe output, or output the model itself flagged for a human, leaves an audit row (no text) for moderators.
export async function recordBlockedOutput(db: Db, roomId: string, reason: string | undefined) {
  if (reason === 'unsafe_output' || reason === 'needs_human_review') {
    await recordModeration(db, { roomId, eventType: 'ai_output_blocked', severity: 'medium', categories: [reason], action: 'not_published' });
  }
}

async function generatePoll(db: Db, room: Pick<RoomRow, 'id' | 'match_id' | 'ai_enabled'>, userId: string | null): Promise<PollIdea | null> {
  const m = room.match_id ? await one<MatchRow>(db, 'SELECT * FROM matches WHERE id = $1', [room.match_id]) : null;
  if (!m) return null;
  const fixture = fixtureFor(m);
  const state = await matchState(db, m);
  const fallback = { ...fixture.engine.templatePoll(state), source: 'template' };
  const orchestrator = await ai();
  if (!orchestrator.available || !room.ai_enabled || !(await aiBudget(db, room, userId))) return fallback;
  const mc = await matchContext(db, room);
  const res = await orchestrator.run({
    task: 'poll', system: SYSTEM, schema: SCHEMAS.poll, roomId: room.id, userId, deadline: 10000,
    user: buildPrompt('poll', { SPORT: fixture.sportName, VERIFIED_MATCH_DATA: mc.facts, COMMENTARY: mc.commentary.slice(0, 5) }),
    validate: (v) => validateOutput('poll', v, mc),
  });
  return res.ok ? { question: res.value.question, options: res.value.options, source: 'ai' } : fallback;
}

export async function handleContinuityJob(db: Db, job: Pick<JobRow, 'room_id'>) {
  const c = config().cohost;
  const room = await one<RoomRow>(db, 'SELECT * FROM rooms WHERE id = $1', [job.room_id]);
  if (!room || room.status !== 'active' || !room.ai_enabled || !room.match_id) return 'skipped';
  const match = await one<Pick<MatchRow, 'status'>>(db, 'SELECT status FROM matches WHERE id = $1', [room.match_id]);
  if (match?.status !== 'live') return 'skipped';
  // Aggregate queries always return one row; idle is null before the room's first member message.
  const last = await one<{ idle: number | null }>(db,
    `SELECT EXTRACT(EPOCH FROM (now() - max(created_at)))::float8 AS idle FROM messages WHERE room_id = $1 AND sender_type = 'user'`, [room.id]);
  if (last?.idle != null && last.idle < c.quietMinutes * 60) return 'not_quiet';
  const online = (await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM room_presence WHERE room_id = $1 AND last_seen_at > now() - interval '45 seconds'`, [room.id]))!;
  if (online.n < 1) return 'nobody_here';
  const recent = (await one<{ n: number }>(db,
    `SELECT count(*)::int AS n FROM polls WHERE room_id = $1 AND created_at > now() - make_interval(mins => $2)`, [room.id, c.promptCooldownMinutes]))!;
  if (recent.n > 0) return 'cooldown';
  const poll = await generatePoll(db, room, null);
  if (!poll) return 'skipped';
  const bucket = Math.floor(Date.now() / (c.promptCooldownMinutes * 60000));
  try {
    await createPoll(db, room.id, { ...poll, idempotencyKey: `continuity:${room.id}:${bucket}` });
  } catch (err) {
    if (err instanceof RoomEndedError || errorCode(err) === 'poll_open') return 'skipped';
    throw err;
  }
  return 'published';
}

export async function suggestPoll(db: Db, user: SessionUser, roomId: string, body: RequestBody) {
  onlyKeys(body, ['client_request_id']);
  if (typeof body.client_request_id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.client_request_id)) throw badRequest('client_request_id is required.');
  const { room } = await roomAccess(db, roomId, user);
  if (!room.match_id) throw badRequest('This room is not following a match.');
  const open = await one<Pick<PollRow, 'id'>>(db, `SELECT id FROM polls WHERE room_id = $1 AND status = 'open' AND closes_at > now()`, [roomId]);
  if (open) throw conflict('There is already an open poll in this room.', 'poll_open');
  const recent = (await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM polls WHERE room_id = $1 AND created_at > now() - interval '60 seconds'`, [roomId]))!; // count(*) always returns a row
  if (recent.n) throw new HttpError(429, 'rate_limited', 'A poll was just posted. Try again in a minute.', { retry_after: 60 });
  const poll = await generatePoll(db, room, user.id);
  if (!poll) throw badRequest('This room is not following a match.');
  const out = await createPoll(db, roomId, { ...poll, requestedBy: user.id, idempotencyKey: `suggest:${roomId}:${body.client_request_id}` });
  return { poll_id: out.id, source: poll.source };
}

export async function handleMomentumJob(db: Db, job: MomentumJob) {
  const signal = await one<SignalRow & { expired: boolean }>(db,
    `SELECT s.*, (s.expires_at <= now()) AS expired FROM match_signals s WHERE s.id = $1`, [job.payload.signal_id]);
  if (!signal || signal.status !== 'pending') return 'done';
  if (signal.expired) {
    await db.query(`UPDATE match_signals SET status = 'expired' WHERE id = $1 AND status = 'pending'`, [signal.id]);
    return 'expired';
  }
  // The AI's one-sentence explanation is optional: the verified fact text stands on its own.
  let aiText: string | null = null;
  let provider: string | null = null;
  let model: string | null = null;
  const orchestrator = await ai();
  const anyAiRoom = await one<Pick<RoomRow, 'id'>>(db, `SELECT id FROM rooms WHERE match_id = $1 AND status = 'active' AND ai_enabled LIMIT 1`, [signal.match_id]);
  if (orchestrator.available && anyAiRoom) {
    const mc = await matchContext(db, { match_id: signal.match_id });
    const allowedEventIds = new Set<string>([...mc.allowedEventIds, signal.event_id]);
    const allowedNumbers = new Set<string>([...mc.allowedNumbers, ...allowedNumbersFrom(signal.evidence, signal.fact_text)]);
    const res = await orchestrator.run({
      task: 'momentum', system: SYSTEM, schema: SCHEMAS.momentum, deadline: 8000,
      user: buildPrompt('momentum', {
        SIGNAL: { event_id: signal.event_id, trigger: signal.trigger, label: signal.label, verified_fact: signal.fact_text, evidence: signal.evidence },
        VERIFIED_MATCH_DATA: mc.facts,
      }),
      validate: (v) => validateOutput('momentum', v, { allowedEventIds, allowedNumbers }),
    });
    if (res.ok) ({ value: { text: aiText }, provider, model } = res);
  }
  const published = await one<Pick<SignalRow, 'id'>>(db,
    `UPDATE match_signals SET status = 'published', published_at = now(), ai_text = $2, ai_provider = $3, ai_model = $4
      WHERE id = $1 AND status = 'pending' AND expires_at > now() RETURNING id`, [signal.id, aiText, provider, model]);
  if (!published) return 'done';
  // Fan-out: one in-app insight per active room following this match (deduped per room + signal).
  const rooms = await many<Pick<RoomRow, 'id'>>(db, `SELECT id FROM rooms WHERE match_id = $1 AND status = 'active'`, [signal.match_id]);
  for (const r of rooms) {
    try {
      const added = await db.tx(async (t) => {
        const seq = await nextSeq(t, r.id);
        const row = await one<{ id: string }>(t,
          `INSERT INTO room_insights (id, room_id, signal_id, seq) VALUES ($1, $2, $3, $4)
           ON CONFLICT (room_id, signal_id) DO NOTHING RETURNING id`,
          [newId('ins'), r.id, signal.id, seq]);
        if (!row) throw Object.assign(new Error('duplicate'), { duplicate: true });
        await appendEvent(t, r.id, 'insight', row.id, seq);
        return true;
      });
      if (added) notifyRoom(r.id);
    } catch (err) {
      const duplicate = err instanceof Error && 'duplicate' in err && err.duplicate;
      if (!(err instanceof RoomEndedError) && !duplicate) throw err;
    }
  }
  return 'published';
}

// Catch Me Up, on request and for the requester only.
export async function catchUp(db: Db, user: SessionUser, roomId: string, body: RequestBody) {
  onlyKeys(body, ['since_seq']);
  const { room } = await roomAccess(db, roomId, user);
  const limited = await takeToken(db, `catchup:${user.id}`, { limit: 4, windowSeconds: 120 });
  if (!limited.ok) throw new HttpError(429, 'rate_limited', 'Give it a moment before catching up again.', { retry_after: limited.retryAfter });
  const sinceSeq = Number.isInteger(body.since_seq) ? clamp(body.since_seq, Math.max(0, room.last_seq - 300), room.last_seq) : Math.max(0, room.last_seq - 40);
  const sinceRow = await one<Pick<RoomEventRow, 'created_at'>>(db, 'SELECT created_at FROM room_events WHERE room_id = $1 AND seq <= $2 ORDER BY seq DESC LIMIT 1', [roomId, sinceSeq]);
  const since = sinceRow?.created_at || null;

  const messages = await roomMessages(db, roomId, { limit: 40, sinceSeq });
  const events = (await eventsSince(db, room.match_id, since)).reverse();
  const signals = await publishedSignalsSince(db, room.match_id, since);
  const polls = await many<PollSummary>(db,
    `SELECT p.question, p.options, p.status,
            (SELECT jsonb_object_agg(option_index, n) FROM (SELECT option_index, count(*)::int AS n FROM poll_votes v WHERE v.poll_id = p.id GROUP BY option_index) c) AS counts
       FROM polls p WHERE p.room_id = $1 AND p.seq > $2 ORDER BY p.seq LIMIT 3`, [roomId, sinceSeq]);
  const mc = await matchContext(db, room);

  // Deterministic summary from verified data: always available, used when AI is off, unavailable or rejected.
  const headline = mc.facts?.headline || 'No match data for this room';
  const people = new Set(messages.map((m) => m.from)).size;
  const fallback = {
    headline,
    match_points: signals.slice(-3).map((s) => `${s.label}: ${s.fact_text}`.slice(0, 110)),
    room_points: [
      messages.length ? `${messages.length} new message${messages.length === 1 ? '' : 's'} from ${people} member${people === 1 ? '' : 's'}.` : 'The chat has been quiet.',
      ...polls.map((p) => {
        const counts: Record<string, number> = p.counts || {};
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        const lead: [string, number] = p.options.map((o, i): [string, number] => [o.label, counts[i] || 0]).sort((a, b) => b[1] - a[1])[0];
        return total ? `Poll "${p.question}": ${Math.round((lead[1] / total) * 100)}% picked ${lead[0]}.` : `Poll "${p.question}" got no votes yet.`;
      }),
    ].slice(0, 3),
  };
  const base = { data_as_of: mc.freshness?.latest_verified_update || null, stale: Boolean(mc.freshness?.stale), source_label: 'Match facts from the match feed' };
  if (!messages.length && !events.length) return { ...fallback, ...base, source: 'match_data', note: 'Nothing new since you looked away.' };

  const orchestrator = await ai();
  if (!room.ai_enabled || !orchestrator.available) return { ...fallback, ...base, source: 'match_data' };
  const allowedEventIds = new Set<string>([...mc.allowedEventIds, ...events.map((e) => e.event_id)]);
  const allowedNumbers = new Set<string>([...mc.allowedNumbers, ...allowedNumbersFrom(events.map((e) => e.data), signals)]);
  const result = await cached(roomId, `catchup:${user.id}:${sinceSeq}:${room.last_seq}`, 20000, () => orchestrator.run({
    task: 'catchup', system: SYSTEM, schema: SCHEMAS.catchup, roomId, userId: user.id, deadline: 14000,
    user: buildPrompt('catchup', {
      VERIFIED_MATCH_DATA: mc.facts,
      MATCH_EVENTS_SINCE: events.map((e) => ({ event_id: e.event_id, text: e.data.text || e.data.label || '', at: e.occurred_at })),
      KEY_MOMENTS_SINCE: signals.map((s) => ({ label: s.label, fact: s.fact_text, event_id: s.event_id })),
      POLLS_SINCE: polls.map((p) => ({ question: p.question, options: p.options.map((o) => o.label), status: p.status, votes: p.counts || {} })),
      ROOM_MESSAGES_SINCE_UNTRUSTED: messages.map(({ from, text }) => ({ from, text })),
      DATA_FRESHNESS: mc.freshness,
    }),
    validate: (v) => validateOutput('catchup', v, { allowedEventIds, allowedNumbers }),
  }));
  if (!result.ok) return { ...fallback, ...base, source: 'match_data', note: 'The AI Co-host is unavailable, so this summary comes straight from match data.' };
  const v = result.value;
  return { headline: v.headline, match_points: v.match_points, room_points: v.room_points, ...base, source: 'ai', label: AI_LABEL };
}
