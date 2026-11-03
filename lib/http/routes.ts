// HTTP API (JSON). The acting user always comes from the session cookie; see docs/api-contract.md.
import { route, reply } from './router.ts';
import { config, type Config } from '../config.ts';
import { one, many } from '../db/index.ts';
import type { MatchRow } from '../db/rows.ts';
import { HttpError, forbidden, notFound, badRequest, onlyKeys, safeEqual } from '../util.ts';
import { sessionCookie, clearSessionCookie, revokeSession, revokeAllSessions } from '../auth/sessions.ts';
import { publicMe, createGuest, updateProfile, setSportChoice, searchUsers, ensureDemoFriends, demoFriends, MAX_PICKS } from '../users.ts';
import { CROWD_SIZE } from '../match/fans.ts';
import { crowdLines } from '../match/crowd.ts';
import {
  roomAccess, isAdminRole, listRooms, createPrivateRoom, inviteToRoom, roomInvitations, myInvitations, respondToInvitation,
  revokeInvitation, joinPublicRoom, leaveRoom, setMemberRole, removeMember, updateRoomSettings,
} from '../rooms/service.ts';
import { controlRoomReplay } from '../rooms/replay.ts';
import { endRoomByUser } from '../rooms/lifecycle.ts';
import { pollEvents, roomBootstrap, parseAfter } from '../rooms/realtime.ts';
import { sendMessage } from '../chat/messages.ts';
import { setReaction, votePoll } from '../chat/interactions.ts';
import { REACTIONS } from '../chat/hydrate.ts';
import { catchUp, suggestPoll } from '../cohost/index.ts';
import { ensureDemoMatch, ensureDemoMatches, matchSnapshot, jumpToMoment } from '../match/feed.ts';
import { fixtureFor, fixtureForMatch, sportRank, SPORTS } from '../match/fixture.ts';
import { getPrefs, setPrefs, saveSubscription, removeSubscriptions } from '../notify/index.ts';
import { pushAvailable } from '../notify/push.ts';
import { reportMessage, appeal, moderationQueue, moderate, resolveAppeal } from '../moderation/reports.ts';
import { publicPolicy, LEVEL_INFO, LEVELS } from '../moderation/policy.ts';
import { aiStatus } from '../ai/index.ts';
import { pump } from '../jobs/worker.ts';
import { sweep } from '../jobs/sweep.ts';
import { queueStats } from '../jobs/queue.ts';
import { metricsSnapshot } from '../metrics.ts';

// ---------------------------------------------------------------- public
route('GET', '/api/health', async ({ db }) => {
  await db.query('SELECT 1');
  return { ok: true, db: db.kind };
}, { auth: 'none' });

route('GET', '/api/config', async () => {
  const cfg = config();
  return {
    auth: { mode: 'guest', available: Boolean(cfg.secret) },
    notifications: { max_per_match: cfg.notify.maxPerMatch },
    push: { available: pushAvailable(), vapid_public_key: pushAvailable() ? cfg.push.publicKey : null },
    demo_controls: cfg.demoControls,
    ai: aiStatus(),
    chat: { cooldown_seconds: cfg.chat.cooldownSeconds, max_length: cfg.chat.maxLength, reactions: REACTIONS },
    moderation: { levels: LEVELS.map((l) => ({ id: l, description: LEVEL_INFO[l] })), public: publicPolicy() },
    retention_hours: cfg.retention.messageHours,
    // The teams and players a fan can back in each sport (demo data, like the games).
    sports: Object.values(SPORTS),
    max_picks: MAX_PICKS,
    crowd: { fans: CROWD_SIZE }, // the simulated fans who chat along with each public watch party
  };
}, { auth: 'none' });

// ---------------------------------------------------------------- auth
// Join: a guest profile (display name, handle, the teams a fan backs) and a session cookie. No phone number or password.
route('POST', '/api/auth/guest', async ({ db, cfg, body, ip }) => {
  const { user, session } = await createGuest(db, cfg, body, ip);
  return reply(201, { user: publicMe(user), needs_profile: false }, { 'set-cookie': sessionCookie(session.token, session.expiresAt) });
}, { auth: 'none' });

route('POST', '/api/auth/logout', async ({ db, session }) => {
  await revokeSession(db, session.id);
  return reply(200, { ok: true }, { 'set-cookie': clearSessionCookie() });
}, { profile: false });

route('POST', '/api/auth/logout-all', async ({ db, user }) => {
  await revokeAllSessions(db, user.id);
  return reply(200, { ok: true }, { 'set-cookie': clearSessionCookie() });
}, { profile: false });

route('GET', '/api/me', async ({ user }) => ({ user: publicMe(user), needs_profile: !user.handle }), { profile: false });
route('PUT', '/api/me/profile', async ({ db, user, body }) => ({ user: await updateProfile(db, user, body) }), { profile: false });
route('PUT', '/api/me/sports/:sport', async ({ db, user, body, params }) => ({ user: await setSportChoice(db, user, params.sport, body) }));
route('GET', '/api/me/notifications', async ({ db, user }) => getPrefs(db, user));
route('PUT', '/api/me/notifications', async ({ db, user, body }) => setPrefs(db, user, body));
route('POST', '/api/me/push-subscriptions', async ({ db, user, body }) => saveSubscription(db, user, body));
route('DELETE', '/api/me/push-subscriptions', async ({ db, user }) => removeSubscriptions(db, user));
route('GET', '/api/me/invitations', async ({ db, user }) => myInvitations(db, user));
route('GET', '/api/users/search', async ({ db, cfg, user, query }) => searchUsers(db, user, query, { includeDemo: cfg.demoFriends }));
route('GET', '/api/users/demo', async ({ db, cfg, user }) => (cfg.demoFriends ? demoFriends(db, user) : { users: [] }));

// ---------------------------------------------------------------- rooms
route('GET', '/api/rooms', async ({ db, cfg, user }) => {
  await ensureDemoMatches(db); // one shared simulated game, with its public watch party, per sport
  if (cfg.demoFriends) await ensureDemoFriends(db);
  const rooms = await listRooms(db, user);
  const matches = (await many<Pick<MatchRow, 'id' | 'title' | 'status' | 'source' | 'fixture_key'>>(db, `SELECT id, title, status, source, fixture_key FROM matches WHERE status IN ('scheduled', 'live') AND room_id IS NULL`))
    .sort((a, b) => sportRank(a.fixture_key) - sportRank(b.fixture_key))
    .map(({ fixture_key: key, ...m }) => ({ ...m, sport: fixtureFor({ fixture_key: key }).sport, sport_name: fixtureFor({ fixture_key: key }).sportName }));
  return { ...rooms, matches };
});
route('POST', '/api/rooms', async ({ db, user, body }) => reply(201, await createPrivateRoom(db, user, body)));
route('GET', '/api/rooms/:id', async ({ db, user, params }) => roomBootstrap(db, user, params.id));

route('GET', '/api/rooms/:id/events', async ({ db, cfg, user, params, query }) => pollEvents(db, user, params.id, {
  after: parseAfter(query.after),
  wait: query.wait === '1',
  visibility: query.vis === 'hidden' ? 'hidden' : 'visible',
  rev: typeof query.rev === 'string' && query.rev.length <= 200 ? query.rev : undefined,
  // Serverless hosting has no worker process: polls use their idle time to run due jobs.
  pump: cfg.worker.inline ? null : (budgetMs) => pump(db, { budgetMs, maxJobs: 4 }),
}));

route('GET', '/api/rooms/:id/match', async ({ db, user, params }) => {
  const { room, role, policy } = await roomAccess(db, params.id, user);
  if (!room.match_id) throw notFound('This room is not following a match.');
  const snap = await matchSnapshot(db, room.match_id);
  if (!snap) throw notFound('This room is not following a match.');
  // Simulated fans fill the public watch party only; a private room holds just the people invited.
  const crowd = room.room_type === 'public' ? await crowdLines(db, { roomId: room.id, matchId: room.match_id, speed: snap.replay.speed, level: policy.level }) : [];
  return { ...snap, replay: { ...snap.replay, can_control: snap.replay.own && room.room_type === 'private' && isAdminRole(role) }, crowd };
});
// For newcomers: the sport's checked rules sheet, its players and questions to ask @huddle.
route('GET', '/api/rooms/:id/guide', async ({ db, user, params }) => {
  const { room } = await roomAccess(db, params.id, user);
  const fixture = await fixtureForMatch(db, room.match_id);
  if (!fixture) throw notFound('This room is not following a match.');
  return { sport: fixture.sport, sport_name: fixture.sportName, title: fixture.title, rules: fixture.rules, roster: fixture.roster, examples: fixture.examples };
});
route('POST', '/api/rooms/:id/replay', async ({ db, user, params, body }) => controlRoomReplay(db, user, params.id, body));

route('POST', '/api/rooms/:id/join', async ({ db, user, params }) => joinPublicRoom(db, user, params.id));
route('POST', '/api/rooms/:id/leave', async ({ db, user, params }) => leaveRoom(db, user, params.id));
route('POST', '/api/rooms/:id/end', async ({ db, user, params }) => endRoomByUser(db, user, params.id));
route('PATCH', '/api/rooms/:id/settings', async ({ db, user, params, body }) => updateRoomSettings(db, user, params.id, body));
route('GET', '/api/rooms/:id/invitations', async ({ db, user, params }) => roomInvitations(db, user, params.id));
route('POST', '/api/rooms/:id/invitations', async ({ db, user, params, body }) => inviteToRoom(db, user, params.id, body));
route('PUT', '/api/rooms/:id/members/:userId/role', async ({ db, user, params, body }) => setMemberRole(db, user, params.id, params.userId, body));
route('DELETE', '/api/rooms/:id/members/:userId', async ({ db, user, params }) => removeMember(db, user, params.id, params.userId));

route('POST', '/api/rooms/:id/messages', async ({ db, user, params, body }) => reply(201, await sendMessage(db, user, params.id, body)));
route('PUT', '/api/rooms/:id/messages/:mid/reactions', async ({ db, user, params, body }) => setReaction(db, user, params.id, params.mid, body));
route('POST', '/api/rooms/:id/messages/:mid/report', async ({ db, user, params, body }) => reportMessage(db, user, params.id, params.mid, body));
route('POST', '/api/rooms/:id/polls/suggest', async ({ db, user, params, body }) => suggestPoll(db, user, params.id, body));
route('POST', '/api/rooms/:id/polls/:pid/vote', async ({ db, user, params, body }) => votePoll(db, user, params.id, params.pid, body));
route('POST', '/api/rooms/:id/catchup', async ({ db, user, params, body }) => catchUp(db, user, params.id, body));

// ---------------------------------------------------------------- invitations
route('POST', '/api/invitations/:id/accept', async ({ db, user, params }) => respondToInvitation(db, user, params.id, 'accept'));
route('POST', '/api/invitations/:id/decline', async ({ db, user, params }) => respondToInvitation(db, user, params.id, 'decline'));
route('POST', '/api/invitations/:id/revoke', async ({ db, user, params }) => revokeInvitation(db, user, params.id));

// ---------------------------------------------------------------- moderation
route('POST', '/api/appeals', async ({ db, user, body }) => appeal(db, user, body));
route('GET', '/api/mod/queue', async ({ db, user }) => moderationQueue(db, user));
route('POST', '/api/mod/messages/:mid', async ({ db, user, params, body }) => moderate(db, user, params.mid, body));
route('POST', '/api/mod/appeals/:rid', async ({ db, user, params, body }) => resolveAppeal(db, user, params.rid, body));

// ---------------------------------------------------------------- demo controls (labelled as such in the UI)
function requireDemo(cfg: Config) {
  if (!cfg.demoControls) throw forbidden('Demo controls are switched off on this server.');
}
route('POST', '/api/demo/matches/:id/jump', async ({ db, cfg, body, params }) => {
  requireDemo(cfg);
  onlyKeys(body, ['moment']);
  if (typeof body.moment !== 'string') throw badRequest('Pick a moment.');
  // A private room's own replay is moved only by that room's owner and admins (POST /api/rooms/:id/replay).
  if ((await one<Pick<MatchRow, 'room_id'>>(db, 'SELECT room_id FROM matches WHERE id = $1', [params.id]))?.room_id) {
    throw forbidden('This replay belongs to a private room; its host controls it from the room.');
  }
  return jumpToMoment(db, params.id, body.moment);
});
route('POST', '/api/demo/matches', async ({ db, cfg }) => {
  requireDemo(cfg);
  return { match_id: await ensureDemoMatch(db) };
});

// ---------------------------------------------------------------- operations
// Last-hour aggregates for the ops view.
interface AiCallStats {
  provider: string | null;
  outcome: string;
  error_category: string;
  n: number;
  p50_ms: number | null;
  max_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  with_fallback: number;
}
interface ModerationStats { event_type: string; action_taken: string; n: number }
interface RoomCounts { active: number; ended_awaiting_purge: number; purge_overdue: number; purged: number }

route('GET', '/api/ops/metrics', async ({ db, user }) => {
  if (!user.is_moderator) throw forbidden('Moderators only.');
  const ai = await many<AiCallStats>(db,
    `SELECT provider, outcome, COALESCE(error_category, '') AS error_category, count(*)::int AS n,
            percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50_ms, max(latency_ms) AS max_ms,
            sum(input_tokens)::int AS input_tokens, sum(output_tokens)::int AS output_tokens,
            count(*) FILTER (WHERE fallback_reason IS NOT NULL)::int AS with_fallback
       FROM ai_calls WHERE created_at > now() - interval '1 hour' GROUP BY 1, 2, 3 ORDER BY 1, 2`);
  const moderation = await many<ModerationStats>(db,
    `SELECT event_type, action_taken, count(*)::int AS n FROM moderation_events WHERE created_at > now() - interval '1 hour' GROUP BY 1, 2`);
  const rooms = await one<RoomCounts>(db,
    `SELECT count(*) FILTER (WHERE status = 'active')::int AS active, count(*) FILTER (WHERE status = 'ended')::int AS ended_awaiting_purge,
            count(*) FILTER (WHERE status = 'ended' AND purge_after <= now())::int AS purge_overdue, count(*) FILTER (WHERE status = 'purged')::int AS purged
       FROM rooms`);
  return { process: metricsSnapshot(), queue: await queueStats(db), ai, moderation, rooms };
});

// Vercel Cron (daily on the Hobby plan) backstop for housekeeping when no one is connected.
route('GET', '/api/cron/sweep', async ({ db, cfg, req }) => {
  const header = String(req.headers.authorization || '');
  if (!cfg.cronSecret || !safeEqual(header, `Bearer ${cfg.cronSecret}`)) throw new HttpError(401, 'unauthenticated', 'Not allowed.');
  await sweep(db);
  return { ran: await pump(db, { budgetMs: 8000, maxJobs: 20 }) };
}, { auth: 'none' });
