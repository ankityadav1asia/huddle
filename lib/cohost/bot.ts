// Dream AI (POST /api/rooms/:id/bot): a member asks anything about the room's match and the answer comes back to
// them alone; nothing is written to the room's messages or events. It is the Co-host's Q&A: the same orchestrator,
// match context, rules sheet, roster and output validation (numbers only from verified data). Room chat is not
// sent: the question is about the match.
import { one, type Db } from '../db/index.ts';
import type { ModerationLevel, RoomRow } from '../db/rows.ts';
import type { SessionUser } from '../auth/sessions.ts';
import { HttpError, badRequest, cleanText, onlyKeys, type RequestBody } from '../util.ts';
import { log } from '../log.ts';
import { ai } from '../ai/index.ts';
import { BOT_SYSTEM, SCHEMAS, buildPrompt, validateOutput, allowedNumbersFrom } from '../ai/tasks.ts';
import { cached, forget } from '../ai/context-cache.ts';
import { roomAccess } from '../rooms/service.ts';
import { classify } from '../moderation/classifier.ts';
import { recordModeration } from '../moderation/audit.ts';
import { matchContext, askedContext } from './context.ts';
import { roomAiToken, userAiToken, recordBlockedOutput } from './index.ts';

type Grounding = 'grounded' | 'rules_sheet' | 'insufficient_data' | 'not_applicable';
// background: what the AI knows about the players, teams or sport, apart from this game's data (null when none).
interface BotReply { answer: string; background: string | null; asked_at: string | null; grounding: Grounding | null; source: 'ai' | 'unavailable' }
type BotRoom = Pick<RoomRow, 'id' | 'match_id' | 'ai_enabled'>;

const REPEAT_MS = 60_000; // a retried request (same client_request_id) gets the same reply, without a second AI call

export async function askDreamBot(db: Db, user: SessionUser, roomId: string, body: RequestBody): Promise<BotReply> {
  onlyKeys(body, ['question', 'client_request_id']);
  if (typeof body.client_request_id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.client_request_id)) throw badRequest('client_request_id is required.');
  const question = cleanText(body.question, { max: 300, field: 'Question' });
  const { room, policy } = await roomAccess(db, roomId, user);
  if (!room.match_id) throw badRequest('This room is not following a match.', 'no_match');
  const key = `bot:${room.match_id}:${user.id}:${body.client_request_id}`;
  try {
    return await cached(room.id, key, REPEAT_MS, () => reply(db, user, room, policy.level, question));
  } catch (err) {
    forget(room.id, key); // a refusal (the rate limit, a room that ended) is not a reply to repeat
    throw err;
  }
}

async function reply(db: Db, user: SessionUser, room: BotRoom, level: ModerationLevel, question: string): Promise<BotReply> {
  const limit = await userAiToken(db, user.id);
  if (!limit.ok) throw new HttpError(429, 'rate_limited', 'Dream AI needs a short break. Ask again in a moment.', { retry_after: limit.retryAfter });
  // asked_at is the latest play: the moment the question is about.
  const latest = await one<{ seq: number | null }>(db, 'SELECT max(seq)::int AS seq FROM match_events WHERE match_id = $1', [room.match_id]);
  const mc = await matchContext(db, room);
  const asked = await askedContext(db, room, latest?.seq ?? null);
  const askedAt = asked?.whenAsked?.at || null;
  const headline = mc.facts?.headline ? ` Latest: ${mc.facts.headline}.` : '';
  const unavailable = (answer: string): BotReply => ({ answer, background: null, asked_at: askedAt, grounding: null, source: 'unavailable' });
  if (!room.ai_enabled) return unavailable(`AI answers are switched off in this room.${headline}`);
  // The chat's safety baseline applies to questions too: one it would stop never reaches an AI provider.
  const decision = classify(question, { level });
  if (decision.action === 'reject' || decision.action === 'hold') {
    await recordModeration(db, { roomId: room.id, targetUserId: user.id, eventType: 'bot_question_blocked', severity: decision.risk, categories: decision.categories, level, action: 'not_sent' });
    return unavailable(decision.action === 'reject' ? `Dream AI can't answer that. ${decision.reason}` : "Dream AI can't answer that. Ask it about the match.");
  }
  const orchestrator = await ai();
  if (!orchestrator.available || !(await roomAiToken(db, room.id)).ok) return unavailable(`Dream AI can't answer right now.${headline}`);

  const grounding = {
    allowedEventIds: new Set<string>([...mc.allowedEventIds, ...(asked?.eventIds || [])]),
    allowedNumbers: new Set<string>([...mc.allowedNumbers, ...allowedNumbersFrom(asked?.rules, asked?.roster, asked?.whenAsked)]),
  };
  const result = await orchestrator.run({
    task: 'bot', system: BOT_SYSTEM, schema: SCHEMAS.bot, roomId: room.id, userId: user.id, deadline: 16000, timeoutMs: 9000,
    user: buildPrompt('bot', {
      SPORT: asked?.sport, MATCH_WHEN_ASKED: asked?.whenAsked || undefined,
      VERIFIED_MATCH_DATA: mc.facts, COMMENTARY: mc.commentary, DATA_FRESHNESS: mc.freshness,
      RULES_SHEET: asked?.rules, ROSTER: asked?.roster,
      QUESTION_UNTRUSTED: question,
    }),
    validate: (v) => validateOutput('bot', v, grounding),
    isCancelled: async () => (await one<Pick<RoomRow, 'status'>>(db, 'SELECT status FROM rooms WHERE id = $1', [room.id]))?.status !== 'active',
  });
  await roomAccess(db, room.id, user); // the room may have ended, or the asker left, while the answer was written
  if (!result.ok) {
    log.info('cohost.bot_unavailable', { room: room.id, category: result.category, reason: result.reason });
    await recordBlockedOutput(db, room.id, result.reason);
    return unavailable(`Dream AI can't answer right now.${headline}`);
  }
  const v = result.value;
  return { answer: v.text, background: v.background.trim() || null, asked_at: askedAt, grounding: v.grounding.status, source: 'ai' };
}
