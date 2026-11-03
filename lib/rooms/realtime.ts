// Realtime delivery by long-polling: GET /api/rooms/:id/events?after=<seq>. Every poll re-authorises the
// caller, so leaving, removal and room closure revoke the stream immediately. Delivery is at-least-once and
// ordered by the room sequence; clients dedupe by sequence number and entity id.
import { config } from '../config.ts';
import { many, one, type Queryable } from '../db/index.ts';
import type { MatchRow, MessageRow, PollRow, RoomRole, RoomRow } from '../db/rows.ts';
import type { SessionUser } from '../auth/sessions.ts';
import { HttpError } from '../util.ts';
import { roomAccess, isAdminRole, type RoomAccess } from './service.ts';
import { RoomEndedError } from './events.ts';
import { waitForRoom } from '../realtime/bus.ts';
import { hydrateEvents, hydrateMessages, hydratePolls, hydrateInsights, type RoomEventRef } from '../chat/hydrate.ts';
import { LEVEL_INFO } from '../moderation/policy.ts';
import { hydrateThreads } from './threads.ts';
import { fixtureFor } from '../match/fixture.ts';
import { observe } from '../metrics.ts';

const ONLINE_SECONDS = 45;

// Whether the viewer's tab is in front ('visible') or in the background ('hidden').
export type Visibility = 'visible' | 'hidden';

export interface PollOptions {
  after: number;
  wait: boolean;
  visibility: Visibility;
  // Optional background-work hook, given the milliseconds it may use (serverless: no worker process).
  pump: ((budgetMs: number) => Promise<unknown>) | null;
  rev?: string;
}

export async function touchPresence(db: Queryable, roomId: string, userId: string, visibility: Visibility) {
  const state = visibility === 'hidden' ? 'inactive' : 'active';
  await db.query(
    `INSERT INTO room_presence (room_id, user_id, state, last_seen_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (room_id, user_id) DO UPDATE SET state = EXCLUDED.state, last_seen_at = now()
     WHERE room_presence.last_seen_at < now() - interval '10 seconds' OR room_presence.state <> EXCLUDED.state`,
    [roomId, userId, state]);
}

async function presence(db: Queryable, roomId: string) {
  const rows = await many<{ user_id: string; state: 'active' | 'inactive' }>(db,
    `SELECT user_id, state FROM room_presence WHERE room_id = $1 AND last_seen_at > now() - make_interval(secs => $2)`,
    [roomId, ONLINE_SECONDS]);
  return { online: rows.map((r) => r.user_id), active: rows.filter((r) => r.state === 'active').map((r) => r.user_id) };
}

// Changes with every new ball and with every replay control (start, pause, speed, restart), so clients know
// when to refetch the match.
async function matchRev(db: Queryable, room: Pick<RoomRow, 'match_id'>) {
  if (!room.match_id) return null;
  const m = await one<Pick<MatchRow, 'id' | 'status' | 'ball_interval_ms'> & { paused: boolean; seq: number }>(db,
    `SELECT m.id, m.status, m.paused_at IS NOT NULL AS paused, m.ball_interval_ms,
            COALESCE((SELECT max(seq) FROM match_events e WHERE e.match_id = m.id), -1)::int AS seq
       FROM matches m WHERE m.id = $1`, [room.match_id]);
  return m ? `${m.id}:${m.seq}:${m.status}:${m.paused ? 'paused' : 'playing'}:${m.ball_interval_ms}` : null;
}

// An ended room's state; `{ id }` alone when its row could not be read.
const endedState = (room: Pick<RoomRow, 'id'> & Partial<Pick<RoomRow, 'status' | 'ended_at'>>) => ({ id: room.id, status: room.status === 'active' ? 'ended' : room.status, ended_at: room.ended_at || null });

// pump: optional background-work hook used where no worker process runs (serverless).
// rev: the match_rev the client already has. The poll also returns as soon as the match moves on from it (a new
// ball, a replay control), so the score and the simulated fans keep pace in a quiet room instead of every 20 s.
export async function pollEvents(db: Queryable, user: SessionUser, roomId: string, { after, wait, visibility, pump, rev: knownRev }: PollOptions) {
  const cursor = Number.isInteger(after) && after >= 0 ? after : 0;
  const deadline = Date.now() + (wait ? 20000 : 0);
  let touched = false;
  for (;;) {
    let access: RoomAccess;
    try {
      access = await roomAccess(db, roomId, user);
    } catch (err) {
      // Ended rooms answer with their state only: no replay of old messages on reconnect.
      if (err instanceof RoomEndedError) {
        const room = await one<Pick<RoomRow, 'id' | 'status' | 'ended_at'>>(db, 'SELECT id, status, ended_at FROM rooms WHERE id = $1', [roomId]);
        return { room: endedState(room || { id: roomId }), events: [], cursor };
      }
      throw err;
    }
    const { room } = access;
    if (!touched) {
      await touchPresence(db, roomId, user.id, visibility);
      touched = true;
    }
    if (cursor > room.last_seq) return { room: { id: room.id, status: room.status, last_seq: room.last_seq }, events: [], cursor: room.last_seq, reset: true };
    const rows = await many<RoomEventRef>(db,
      'SELECT seq, type, entity_id FROM room_events WHERE room_id = $1 AND seq > $2 ORDER BY seq LIMIT 100', [roomId, cursor]);
    const rev = knownRev !== undefined ? await matchRev(db, room) : undefined;
    if (rows.length || (knownRev !== undefined && rev !== knownRev) || Date.now() >= deadline) {
      const events = await hydrateEvents(db, room, user.id, rows);
      // Send-to-delivery latency for fresh events (the server's view; network time to the client excluded).
      for (const r of await many<{ ms: number }>(db,
        `SELECT EXTRACT(EPOCH FROM (now() - created_at))::float8 * 1000 AS ms FROM room_events
          WHERE room_id = $1 AND seq > $2 AND created_at > now() - interval '30 seconds' ORDER BY seq LIMIT 100`, [roomId, cursor])) {
        observe('delivery_ms', Math.round(r.ms));
      }
      return {
        room: { id: room.id, status: room.status, last_seq: room.last_seq, ai_enabled: room.ai_enabled, moderation_level: room.room_type === 'private' ? room.moderation_level : null },
        events,
        cursor: rows.length ? rows[rows.length - 1].seq : cursor,
        presence: await presence(db, roomId),
        match_rev: rev !== undefined ? rev : await matchRev(db, room),
      };
    }
    if (pump) await pump(Math.min(4000, deadline - Date.now()));
    await waitForRoom(roomId, Math.max(50, Math.min(1000, deadline - Date.now())));
  }
}

// A member as the room lists them, with the team they back in the room's sport.
interface RoomMemberRow { id: string; handle: string | null; name: string | null; team: string | null; role: RoomRole }

// Room bootstrap for an active member: details plus a short recent window, never the full history.
export async function roomBootstrap(db: Queryable, user: SessionUser, roomId: string) {
  let access: RoomAccess;
  try {
    access = await roomAccess(db, roomId, user);
  } catch (err) {
    if (err instanceof RoomEndedError) {
      const room = await one<Pick<RoomRow, 'id' | 'name' | 'room_type' | 'status' | 'ended_at'>>(db, 'SELECT id, name, room_type, status, ended_at FROM rooms WHERE id = $1', [roomId]);
      return { room: { ...endedState(room || { id: roomId }), name: room?.name || null, room_type: room?.room_type }, items: [] };
    }
    throw err;
  }
  const { room, role, policy } = access;
  // Opening the room is being here: count the viewer as online at once, not only after their first long-poll.
  await touchPresence(db, roomId, user.id, 'visible');
  const window = config().rooms.historyWindow;
  const msgIds = (await many<Pick<MessageRow, 'id'>>(db,
    `SELECT id FROM messages WHERE room_id = $1 AND (status IN ('visible', 'removed') OR (status = 'held' AND sender_id = $2))
      ORDER BY created_at DESC LIMIT $3`, [roomId, user.id, window])).map((r) => r.id);
  const pollIds = (await many<Pick<PollRow, 'id'>>(db, 'SELECT id FROM polls WHERE room_id = $1 ORDER BY created_at DESC LIMIT 5', [roomId])).map((r) => r.id);
  const insightIds = (await many<{ id: string }>(db, 'SELECT id FROM room_insights WHERE room_id = $1 ORDER BY seq DESC LIMIT 10', [roomId])).map((r) => r.id);
  const [messages, polls, insights] = [
    await hydrateMessages(db, roomId, msgIds, user.id),
    await hydratePolls(db, roomId, pollIds, user.id),
    await hydrateInsights(db, roomId, insightIds, room.ai_enabled),
  ];
  const items = [
    ...[...messages.values()].map((data) => ({ type: 'message', seq: data.seq, data })),
    ...[...polls.values()].map((data) => ({ type: 'poll', seq: data.seq, data })),
    ...[...insights.values()].map((data) => ({ type: 'insight', seq: data.seq, data })),
  ].sort((a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity));
  const matchRow = room.match_id ? await one<Pick<MatchRow, 'id' | 'title' | 'status' | 'fixture_key'>>(db, 'SELECT id, title, status, fixture_key FROM matches WHERE id = $1', [room.match_id]) : null;
  const fixture = matchRow ? fixtureFor(matchRow) : null;
  // Each member shows the team they back in this room's sport.
  const members = await many<RoomMemberRow>(db,
    `SELECT u.id, u.handle, u.display_name AS name, u.sports -> $2::text ->> 'team' AS team, m.role FROM room_members m JOIN users u ON u.id = m.user_id
      WHERE m.room_id = $1 AND m.status = 'active' ORDER BY (m.role = 'owner') DESC, (m.role = 'admin') DESC, m.joined_at`, [roomId, fixture?.sport ?? null]);
  const cooldown = await one<{ next_allowed_at: Date }>(db, 'SELECT next_allowed_at FROM user_send_cooldowns WHERE user_id = $1 AND next_allowed_at > now()', [user.id]);
  const match = matchRow ? { id: matchRow.id, title: matchRow.title, status: matchRow.status, sport: fixture!.sport, sport_name: fixture!.sportName } : null;
  return {
    room: {
      id: room.id, name: room.name, room_type: room.room_type, status: room.status, last_seq: room.last_seq,
      ai_enabled: room.ai_enabled, match, my_role: role, can_manage: isAdminRole(role) && room.room_type === 'private',
      moderation: room.room_type === 'public'
        ? { managed_by: 'huddle', level: null, notice: 'Moderation and safety settings are managed by Huddle.' }
        : { managed_by: 'room', level: policy.level, description: LEVEL_INFO[policy.level], notice: 'Mandatory safety protections stay on at every level.' },
      retention_notice: `Messages disappear for everyone when the watch party ends and are deleted from our servers within ${config().retention.messageHours} hours.`,
      ai_notice: room.ai_enabled
        ? 'The AI Co-host reads recent messages in this room only, to answer questions, catch you up and suggest polls. Match facts come from the demo feed.'
        : 'The AI Co-host is off in this room.',
    },
    members,
    // The public watch party's simulated fans (labelled in the UI); private rooms have none.
    simulated_fans: fixture && room.room_type === 'public' ? fixture.crowd.fans : [],
    items,
    threads: [...(await hydrateThreads(db, roomId)).values()],
    cursor: room.last_seq,
    presence: await presence(db, roomId),
    cooldown_until: cooldown?.next_allowed_at || null,
    match_rev: await matchRev(db, room),
  };
}

export function parseAfter(value: string | undefined) {
  if (value === undefined) return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, 'invalid_cursor', 'after must be a non-negative integer.');
  return n;
}
