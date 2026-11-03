// The AI Co-host: answers to questions nobody answered, polls from the room's chat and match momentum explanations
// (its private Q&A, the Dream Bot, is in bot.ts; Catch Me Up in catchup.ts). Each re-checks room state and membership
// before publishing, and never publishes unchecked output.
import { config } from '../config.ts';
import { one, many, type Db } from '../db/index.ts';
import type { JobRow, MatchRow, MessageRow, PollRow, RoomRow, SignalRow } from '../db/rows.ts';
import type { SessionUser } from '../auth/sessions.ts';
import { HttpError, badRequest, conflict, onlyKeys, newId, errorCode, type RequestBody } from '../util.ts';
import { log } from '../log.ts';
import { ai } from '../ai/index.ts';
import { SYSTEM, SCHEMAS, buildPrompt, validateOutput, allowedNumbersFrom } from '../ai/tasks.ts';
import { roomAccess, type MemberStatus } from '../rooms/service.ts';
import { nextSeq, appendEvent, RoomEndedError } from '../rooms/events.ts';
import { notifyRoom } from '../realtime/bus.ts';
import { takeToken } from '../limits.ts';
import { createPoll } from '../chat/polls.ts';
import { matchContext, askedContext, roomMessages } from './context.ts';
import { matchState } from '../match/feed.ts';
import { fixtureFor } from '../match/fixture.ts';
import { recordModeration } from '../moderation/audit.ts';
import { enqueue } from '../jobs/queue.ts';
import { crowdLines } from '../match/crowd.ts';

const AI_LABEL = 'AI Co-host';

// Jobs as the handlers read them (payloads hold ids only; lib/chat/messages.ts and lib/match/feed.ts queue them).
type AnswerJob = Pick<JobRow, 'room_id'> & { payload: { message_id: string } };
type MomentumJob = { payload: { signal_id: string } };
// since_seq: the room's chat from this point is what the room argued about (null: its latest messages).
type DebateJob = Pick<JobRow, 'room_id'> & { payload: { since_seq?: number | null } };
// The claimed question: a member's message, so it always has a sender and text.
type Question = Pick<MessageRow, 'id' | 'room_id' | 'seq' | 'thread_id' | 'match_seq'> & { sender_id: string; body: string };
// A fresh poll: AI-written from what the room is saying, or the sport's template when the AI is off or fails.
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

type PollRoom = Pick<RoomRow, 'id' | 'match_id' | 'ai_enabled' | 'room_type'>;

// What the room is saying: members' recent messages (pseudonymised) and, in a public room, the crowd's lines on screen.
async function roomChat(db: Db, room: PollRoom, sinceSeq: number | null) {
  const members = (await roomMessages(db, room.id, { limit: 20, sinceSeq })).map(({ from, text }) => ({ from, text }));
  const crowd = room.room_type === 'public' && room.match_id
    ? (await crowdLines(db, { roomId: room.id, matchId: room.match_id })).slice(-25).map((l) => ({ side: l.team, text: l.text }))
    : [];
  return { members, crowd };
}

async function generatePoll(db: Db, room: PollRoom, userId: string | null, { sinceSeq = null }: { sinceSeq?: number | null } = {}): Promise<PollIdea | null> {
  const m = room.match_id ? await one<MatchRow>(db, 'SELECT * FROM matches WHERE id = $1', [room.match_id]) : null;
  if (!m) return null;
  const fixture = fixtureFor(m);
  const state = await matchState(db, m);
  const fallback = { ...fixture.engine.templatePoll(state), source: 'template' };
  const orchestrator = await ai();
  if (!orchestrator.available || !room.ai_enabled || !(await aiBudget(db, room, userId))) return fallback;
  const mc = await matchContext(db, room);
  const chat = await roomChat(db, room, sinceSeq);
  const res = await orchestrator.run({
    task: 'poll', system: SYSTEM, schema: SCHEMAS.poll, roomId: room.id, userId, deadline: 10000, timeoutMs: 4500,
    user: buildPrompt('poll', {
      SPORT: fixture.sportName, VERIFIED_MATCH_DATA: mc.facts, COMMENTARY: mc.commentary.slice(0, 5),
      ROOM_CHAT_UNTRUSTED: chat.members.length ? chat.members : undefined,
      CROWD_CHAT_UNTRUSTED: chat.crowd.length ? chat.crowd : undefined,
    }),
    validate: (v) => validateOutput('poll', v, mc),
  });
  return res.ok ? { question: res.value.question, options: res.value.options, source: 'ai' } : fallback;
}

// The room is arguing (a big moment just happened, or members started a #thread): the AI Co-host reads the chat and
// asks the room what it is arguing about, at most one poll every DEBATE_POLL_COOLDOWN_MINUTES and never over an open one.
export async function handleDebatePollJob(db: Db, job: DebateJob) {
  const c = config().cohost;
  const room = await one<RoomRow>(db, 'SELECT * FROM rooms WHERE id = $1', [job.room_id]);
  if (!room || room.status !== 'active' || !room.ai_enabled || !room.match_id) return 'skipped';
  const match = await one<Pick<MatchRow, 'status'>>(db, 'SELECT status FROM matches WHERE id = $1', [room.match_id]);
  if (match?.status !== 'live') return 'skipped';
  const online = (await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM room_presence WHERE room_id = $1 AND last_seen_at > now() - interval '45 seconds'`, [room.id]))!;
  if (online.n < 1) return 'nobody_here';
  const busy = (await one<{ n: number }>(db,
    `SELECT count(*)::int AS n FROM polls WHERE room_id = $1 AND ((status = 'open' AND closes_at > now()) OR created_at > now() - make_interval(mins => $2))`,
    [room.id, c.debatePollCooldownMinutes]))!;
  if (busy.n > 0) return 'cooldown';
  const sinceSeq = Number.isInteger(job.payload.since_seq) ? job.payload.since_seq! : null;
  // A poll needs a real argument: members talking, or (in a public room) the stands reacting.
  const chat = await roomChat(db, room, sinceSeq);
  if (chat.members.length < 2 && chat.crowd.length < 6) return 'quiet';
  const poll = await generatePoll(db, room, null, { sinceSeq });
  if (!poll) return 'skipped';
  try {
    await createPoll(db, room.id, { ...poll, idempotencyKey: `debate:${room.id}:${sinceSeq ?? 'latest'}` });
  } catch (err) {
    if (err instanceof RoomEndedError || errorCode(err) === 'poll_open') return 'skipped';
    throw err;
  }
  return 'published';
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
      task: 'momentum', system: SYSTEM, schema: SCHEMAS.momentum, deadline: 10000, timeoutMs: 4500,
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
  const rooms = await many<Pick<RoomRow, 'id' | 'ai_enabled'>>(db, `SELECT id, ai_enabled FROM rooms WHERE match_id = $1 AND status = 'active'`, [signal.match_id]);
  const c = config().cohost;
  for (const r of rooms) {
    try {
      const added = await db.tx(async (t) => {
        const seq = await nextSeq(t, r.id);
        // A big moment gets the room arguing: once it has had its say, the Co-host may poll it on what it argued about.
        if (r.ai_enabled && signal.priority !== 'low') {
          await enqueue(t, { type: 'debate_poll', roomId: r.id, dedupeKey: `debate:${r.id}:${signal.id}`, payload: { since_seq: seq },
            delaySeconds: c.debatePollDelaySeconds, priority: 7, expiresInSeconds: c.debatePollDelaySeconds + 120 });
        }
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
