// The integrated AI Co-host: one orchestration layer behind four behaviours - answering questions (mentions and
// unanswered questions), conversation continuity (quiet-room polls), match momentum explanations and Catch Me Up.
// Every behaviour re-checks room state and membership before publishing, and never publishes unchecked output.
import { config } from '../config.js';
import { one, many } from '../db/index.js';
import { HttpError, badRequest, conflict, onlyKeys, clamp, newId } from '../util.js';
import { log } from '../log.js';
import { ai } from '../ai/index.js';
import { SYSTEM, SCHEMAS, buildPrompt, validateOutput, allowedNumbersFrom } from '../ai/tasks.js';
import { roomAccess } from '../rooms/service.js';
import { nextSeq, appendEvent, RoomEndedError } from '../rooms/events.js';
import { notifyRoom } from '../realtime/bus.js';
import { takeToken } from '../limits.js';
import { createPoll } from '../chat/polls.js';
import { matchContext, roomMessages, eventsSince, publishedSignalsSince } from './context.js';
import { matchState } from '../match/feed.js';
import { fixtureFor } from '../match/fixture.js';
import { rates } from '../match/scorecard.js';
import { queueMomentumPushes, queueAnswerPush } from '../notify/index.js';
import { recordModeration } from '../moderation/audit.js';
import { cached } from '../ai/context-cache.js';

const AI_LABEL = 'AI Co-host';

async function aiBudget(db, room, userId) {
  const c = config().cohost;
  const roomOk = await takeToken(db, `ai_room:${room.id}`, { limit: c.roomAiPer10Min, windowSeconds: 600 });
  if (!roomOk.ok) return false;
  if (!userId) return true;
  return (await takeToken(db, `ai_user:${userId}`, { limit: c.userAiPer5Min, windowSeconds: 300 })).ok;
}

// ---------------------------------------------------------------- answers (mention or unanswered question)
export async function handleAnswerJob(db, job) {
  const { message_id: messageId, mode } = job.payload;
  // Compare-and-set: only one path (a human reply or this job) can win the question.
  const q = await one(db,
    `UPDATE messages SET answer_state = 'ai_claimed' WHERE id = $1 AND room_id = $2 AND answer_state = 'pending'
     RETURNING id, room_id, sender_id, body, seq, thread_id`, [messageId, job.room_id]);
  if (!q) return 'cancelled';
  const room = await one(db, 'SELECT * FROM rooms WHERE id = $1', [q.room_id]);
  const asker = await one(db, `SELECT status FROM room_members WHERE room_id = $1 AND user_id = $2`, [q.room_id, q.sender_id]);
  const giveUp = async (state, visible) => {
    await db.tx(async (t) => {
      await t.query(`UPDATE messages SET answer_state = $2 WHERE id = $1 AND answer_state = 'ai_claimed'`, [q.id, state]);
      if (visible) await appendEvent(t, q.room_id, 'message_update', q.id);
    }).catch((err) => { if (!(err instanceof RoomEndedError)) throw err; });
    if (visible) notifyRoom(q.room_id);
    return state;
  };
  if (!room || room.status !== 'active' || !room.ai_enabled || asker?.status !== 'active') return giveUp('cancelled', false);
  if (!(await aiBudget(db, room, mode === 'mention' ? q.sender_id : null))) return giveUp(mode === 'mention' ? 'ai_unavailable' : 'cancelled', mode === 'mention');

  const orchestrator = await ai();
  const mc = await matchContext(db, room);
  const question = q.body.replace(/(^|\s)@huddle\b/gi, ' ').trim() || q.body;
  const recent = await roomMessages(db, room.id, { limit: 12 });
  const result = await orchestrator.run({
    task: 'answer', system: SYSTEM, schema: SCHEMAS.answer, roomId: room.id, userId: q.sender_id,
    user: buildPrompt('answer', {
      VERIFIED_MATCH_DATA: mc.facts, COMMENTARY: mc.commentary, DATA_FRESHNESS: mc.freshness,
      ROOM_MESSAGES_UNTRUSTED: recent.filter((m) => m.message_id !== q.id).map(({ from, text }) => ({ from, text })),
      QUESTION_UNTRUSTED: question,
    }),
    validate: (v) => validateOutput('answer', v, mc),
    isCancelled: async () => (await one(db, `SELECT status FROM rooms WHERE id = $1`, [room.id]))?.status !== 'active',
  });
  if (!result.ok) {
    log.info('cohost.answer_unavailable', { room: room.id, category: result.category, mode });
    if (result.reason === 'unsafe_output' || result.reason === 'needs_human_review') {
      await recordModeration(db, { roomId: room.id, eventType: 'ai_output_blocked', severity: 'medium', categories: [result.reason], action: 'not_published' });
    }
    return giveUp(mode === 'mention' ? 'ai_unavailable' : 'cancelled', mode === 'mention');
  }
  const v = result.value;
  const meta = {
    label: AI_LABEL, kind: 'answer', type: v.type, confidence: v.confidence, language: v.language,
    grounding: { status: v.grounding.status, source_event_ids: v.grounding.sourceEventIds, data_as_of: mc.freshness?.latest_verified_update || null, stale: Boolean(mc.freshness?.stale), source: 'demo_fixture' },
    provider: result.provider, model: result.model, fallback_used: result.fallbackUsed,
  };
  // Idempotent publication: the client key is derived from the question, so a re-run cannot post twice.
  const published = await db.tx(async (t) => {
    const claim = await one(t, `UPDATE messages SET answer_state = 'ai_answered' WHERE id = $1 AND answer_state = 'ai_claimed' RETURNING id`, [q.id]);
    if (!claim) return null;
    const seq = await nextSeq(t, room.id);
    const row = await one(t,
      `INSERT INTO messages (id, room_id, seq, sender_type, sender_id, client_msg_id, body, reply_to_id, status, ai_meta, thread_id)
       VALUES ($1, $2, $3, 'ai', NULL, $4, $5, $6, 'visible', $7::jsonb, $8)
       ON CONFLICT (room_id, client_msg_id) WHERE sender_type = 'ai' DO NOTHING RETURNING id`,
      [newId('msg'), room.id, seq, `ai:answer:${q.id}`, v.text, q.id, JSON.stringify(meta), q.thread_id]); // answers stay in the question's thread
    if (!row) return null;
    await appendEvent(t, room.id, 'message', row.id, seq);
    await appendEvent(t, room.id, 'message_update', q.id);
    return row.id;
  }).catch((err) => { if (err instanceof RoomEndedError) return null; throw err; });
  if (!published) return 'discarded';
  notifyRoom(room.id);
  await queueAnswerPush(db, { roomId: room.id, userId: q.sender_id, messageId: q.id });
  return 'published';
}

// ---------------------------------------------------------------- conversation continuity
function templatePoll(state) {
  const r = rates(state);
  if (state.result || r.need_runs === 0) return { question: 'Player of the match?', options: [`${state.batting} batter`, `${state.bowling} bowler`] };
  return { question: `${state.batting} need ${r.need_runs} off ${r.need_balls}. Who wins?`, options: [`${state.batting} chase it`, `${state.bowling} defend it`] };
}

async function generatePoll(db, room, userId) {
  const m = room.match_id ? await one(db, 'SELECT * FROM matches WHERE id = $1', [room.match_id]) : null;
  if (!m) return null;
  const state = await matchState(db, m);
  const fallback = { ...templatePoll(state), source: 'template' };
  const orchestrator = await ai();
  if (!orchestrator.available || !room.ai_enabled || !(await aiBudget(db, room, userId))) return fallback;
  const mc = await matchContext(db, room);
  const res = await orchestrator.run({
    task: 'poll', system: SYSTEM, schema: SCHEMAS.poll, roomId: room.id, userId, deadline: 10000,
    user: buildPrompt('poll', { VERIFIED_MATCH_DATA: mc.facts, COMMENTARY: mc.commentary.slice(0, 5) }),
    validate: (v) => validateOutput('poll', v, mc),
  });
  return res.ok ? { question: res.value.question, options: res.value.options, source: 'ai' } : fallback;
}

export async function handleContinuityJob(db, job) {
  const c = config().cohost;
  const room = await one(db, 'SELECT * FROM rooms WHERE id = $1', [job.room_id]);
  if (!room || room.status !== 'active' || !room.ai_enabled || !room.match_id) return 'skipped';
  const match = await one(db, 'SELECT status FROM matches WHERE id = $1', [room.match_id]);
  if (match?.status !== 'live') return 'skipped';
  const last = await one(db,
    `SELECT EXTRACT(EPOCH FROM (now() - max(created_at)))::float8 AS idle FROM messages WHERE room_id = $1 AND sender_type = 'user'`, [room.id]);
  if (last?.idle != null && last.idle < c.quietMinutes * 60) return 'not_quiet';
  const online = await one(db, `SELECT count(*)::int AS n FROM room_presence WHERE room_id = $1 AND last_seen_at > now() - interval '45 seconds'`, [room.id]);
  if (online.n < 1) return 'nobody_here';
  const recent = await one(db,
    `SELECT count(*)::int AS n FROM polls WHERE room_id = $1 AND created_at > now() - make_interval(mins => $2)`, [room.id, c.promptCooldownMinutes]);
  if (recent.n > 0) return 'cooldown';
  const poll = await generatePoll(db, room, null);
  if (!poll) return 'skipped';
  const bucket = Math.floor(Date.now() / (c.promptCooldownMinutes * 60000));
  try {
    await createPoll(db, room.id, { ...poll, idempotencyKey: `continuity:${room.id}:${bucket}` });
  } catch (err) {
    if (err instanceof RoomEndedError || err?.code === 'poll_open') return 'skipped';
    throw err;
  }
  return 'published';
}

export async function suggestPoll(db, user, roomId, body) {
  onlyKeys(body, ['client_request_id']);
  if (typeof body.client_request_id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.client_request_id)) throw badRequest('client_request_id is required.');
  const { room } = await roomAccess(db, roomId, user);
  if (!room.match_id) throw badRequest('This room is not following a match.');
  const open = await one(db, `SELECT id FROM polls WHERE room_id = $1 AND status = 'open' AND closes_at > now()`, [roomId]);
  if (open) throw conflict('There is already an open poll in this room.', 'poll_open');
  const recent = await one(db, `SELECT count(*)::int AS n FROM polls WHERE room_id = $1 AND created_at > now() - interval '60 seconds'`, [roomId]);
  if (recent.n) throw new HttpError(429, 'rate_limited', 'A poll was just posted. Try again in a minute.', { retry_after: 60 });
  const poll = await generatePoll(db, room, user.id);
  const out = await createPoll(db, roomId, { ...poll, requestedBy: user.id, idempotencyKey: `suggest:${roomId}:${body.client_request_id}` });
  return { poll_id: out.id, source: poll.source };
}

// ---------------------------------------------------------------- match momentum
export async function handleMomentumJob(db, job) {
  const signal = await one(db,
    `SELECT s.*, (s.expires_at <= now()) AS expired FROM match_signals s WHERE s.id = $1`, [job.payload.signal_id]);
  if (!signal || signal.status !== 'pending') return 'done';
  if (signal.expired) {
    await db.query(`UPDATE match_signals SET status = 'expired' WHERE id = $1 AND status = 'pending'`, [signal.id]);
    return 'expired';
  }
  // Stage 2: the AI explains the verified signal in one sentence. Optional; the fact text stands on its own.
  let aiText = null;
  let provider = null;
  let model = null;
  const orchestrator = await ai();
  const anyAiRoom = await one(db, `SELECT id FROM rooms WHERE match_id = $1 AND status = 'active' AND ai_enabled LIMIT 1`, [signal.match_id]);
  if (orchestrator.available && anyAiRoom) {
    const mc = await matchContext(db, { match_id: signal.match_id });
    const allowedEventIds = new Set([...mc.allowedEventIds, signal.event_id]);
    const allowedNumbers = new Set([...mc.allowedNumbers, ...allowedNumbersFrom(signal.evidence, signal.fact_text)]);
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
  const published = await one(db,
    `UPDATE match_signals SET status = 'published', published_at = now(), ai_text = $2, ai_provider = $3, ai_model = $4
      WHERE id = $1 AND status = 'pending' AND expires_at > now() RETURNING id`, [signal.id, aiText, provider, model]);
  if (!published) return 'done';
  // Fan-out: one in-app insight per active room following this match (deduped per room + signal).
  const rooms = await many(db, `SELECT id FROM rooms WHERE match_id = $1 AND status = 'active'`, [signal.match_id]);
  for (const r of rooms) {
    try {
      const added = await db.tx(async (t) => {
        const seq = await nextSeq(t, r.id);
        const row = await one(t,
          `INSERT INTO room_insights (id, room_id, signal_id, seq) VALUES ($1, $2, $3, $4)
           ON CONFLICT (room_id, signal_id) DO NOTHING RETURNING id`,
          [newId('ins'), r.id, signal.id, seq]);
        if (!row) throw Object.assign(new Error('duplicate'), { duplicate: true });
        await appendEvent(t, r.id, 'insight', row.id, seq);
        return true;
      });
      if (added) notifyRoom(r.id);
    } catch (err) {
      if (!(err instanceof RoomEndedError) && !err.duplicate) throw err;
    }
  }
  await queueMomentumPushes(db, signal); // applies the priority filter and the per-match cap
  return 'published';
}

// ---------------------------------------------------------------- Catch Me Up (on request, to the requester only)
export async function catchUp(db, user, roomId, body) {
  onlyKeys(body, ['since_seq']);
  const { room } = await roomAccess(db, roomId, user);
  const limited = await takeToken(db, `catchup:${user.id}`, { limit: 4, windowSeconds: 120 });
  if (!limited.ok) throw new HttpError(429, 'rate_limited', 'Give it a moment before catching up again.', { retry_after: limited.retryAfter });
  const sinceSeq = Number.isInteger(body.since_seq) ? clamp(body.since_seq, Math.max(0, room.last_seq - 300), room.last_seq) : Math.max(0, room.last_seq - 40);
  const sinceRow = await one(db, 'SELECT created_at FROM room_events WHERE room_id = $1 AND seq <= $2 ORDER BY seq DESC LIMIT 1', [roomId, sinceSeq]);
  const since = sinceRow?.created_at || null;

  const messages = await roomMessages(db, roomId, { limit: 40, sinceSeq });
  const events = (await eventsSince(db, room.match_id, since)).reverse();
  const signals = await publishedSignalsSince(db, room.match_id, since);
  const polls = await many(db,
    `SELECT p.question, p.options, p.status,
            (SELECT jsonb_object_agg(option_index, n) FROM (SELECT option_index, count(*)::int AS n FROM poll_votes v WHERE v.poll_id = p.id GROUP BY option_index) c) AS counts
       FROM polls p WHERE p.room_id = $1 AND p.seq > $2 ORDER BY p.seq LIMIT 3`, [roomId, sinceSeq]);
  const mc = await matchContext(db, room);

  // Deterministic summary from verified data: always available, used when AI is off, unavailable or rejected.
  const headline = mc.facts ? `${mc.facts.batting} ${mc.facts.score} (${mc.facts.overs})${mc.facts.result ? ` · ${mc.facts.result}` : mc.facts.need_runs ? ` · need ${mc.facts.need_runs} off ${mc.facts.balls_left}` : ''}` : 'No match data for this room';
  const people = new Set(messages.map((m) => m.from)).size;
  const fallback = {
    headline,
    match_points: signals.slice(-3).map((s) => `${s.label}: ${s.fact_text}`.slice(0, 110)),
    room_points: [
      messages.length ? `${messages.length} new message${messages.length === 1 ? '' : 's'} from ${people} member${people === 1 ? '' : 's'}.` : 'The chat has been quiet.',
      ...polls.map((p) => {
        const counts = p.counts || {};
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        const lead = p.options.map((o, i) => [o.label, counts[i] || 0]).sort((a, b) => b[1] - a[1])[0];
        return total ? `Poll "${p.question}": ${Math.round((lead[1] / total) * 100)}% picked ${lead[0]}.` : `Poll "${p.question}" got no votes yet.`;
      }),
    ].slice(0, 3),
  };
  const base = { data_as_of: mc.freshness?.latest_verified_update || null, stale: Boolean(mc.freshness?.stale), source_label: 'Match facts from the demo replay feed' };
  if (!messages.length && !events.length) return { ...fallback, ...base, source: 'match_data', note: 'Nothing new since you looked away.' };

  const orchestrator = await ai();
  if (!room.ai_enabled || !orchestrator.available) return { ...fallback, ...base, source: 'match_data' };
  const allowedEventIds = new Set([...mc.allowedEventIds, ...events.map((e) => e.event_id)]);
  const allowedNumbers = new Set([...mc.allowedNumbers, ...allowedNumbersFrom(events.map((e) => e.data), signals)]);
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

export { fixtureFor };
