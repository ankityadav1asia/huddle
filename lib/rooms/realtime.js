// Realtime delivery by long-polling: GET /api/rooms/:id/events?after=<seq>. Every poll re-authorises the
// caller, so leaving, removal and room closure revoke the stream immediately. Delivery is at-least-once and
// ordered by the room sequence; clients dedupe by sequence number and entity id.
import { config } from '../config.js';
import { many, one } from '../db/index.js';
import { HttpError } from '../util.js';
import { roomAccess, isAdminRole } from './service.js';
import { RoomEndedError } from './events.js';
import { waitForRoom } from '../realtime/bus.js';
import { hydrateEvents, hydrateMessages, hydratePolls, hydrateInsights } from '../chat/hydrate.js';
import { LEVEL_INFO } from '../moderation/policy.js';
import { observe } from '../metrics.js';

const ONLINE_SECONDS = 45;

export async function touchPresence(db, roomId, userId, visibility) {
  const state = visibility === 'hidden' ? 'inactive' : 'active';
  await db.query(
    `INSERT INTO room_presence (room_id, user_id, state, last_seen_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (room_id, user_id) DO UPDATE SET state = EXCLUDED.state, last_seen_at = now()
     WHERE room_presence.last_seen_at < now() - interval '10 seconds' OR room_presence.state <> EXCLUDED.state`,
    [roomId, userId, state]);
}

async function presence(db, roomId) {
  const rows = await many(db,
    `SELECT user_id, state FROM room_presence WHERE room_id = $1 AND last_seen_at > now() - make_interval(secs => $2)`,
    [roomId, ONLINE_SECONDS]);
  return { online: rows.map((r) => r.user_id), active: rows.filter((r) => r.state === 'active').map((r) => r.user_id) };
}

async function matchRev(db, room) {
  if (!room.match_id) return null;
  return (await one(db, 'SELECT COALESCE(max(seq), -1)::int AS rev FROM match_events WHERE match_id = $1', [room.match_id])).rev;
}

const endedState = (room) => ({ id: room.id, status: room.status === 'active' ? 'ended' : room.status, ended_at: room.ended_at || null });

// pump: optional background-work hook used where no worker process runs (serverless).
export async function pollEvents(db, user, roomId, { after, wait, visibility, pump }) {
  const cursor = Number.isInteger(after) && after >= 0 ? after : 0;
  const deadline = Date.now() + (wait ? 20000 : 0);
  let touched = false;
  for (;;) {
    let access;
    try {
      access = await roomAccess(db, roomId, user);
    } catch (err) {
      // Ended rooms answer with their state only: no replay of old messages on reconnect.
      if (err instanceof RoomEndedError) {
        const room = await one(db, 'SELECT id, status, ended_at FROM rooms WHERE id = $1', [roomId]);
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
    const rows = await many(db,
      'SELECT seq, type, entity_id FROM room_events WHERE room_id = $1 AND seq > $2 ORDER BY seq LIMIT 100', [roomId, cursor]);
    if (rows.length || Date.now() >= deadline) {
      const events = await hydrateEvents(db, room, user.id, rows);
      // Send-to-delivery latency for fresh events (the server's view; network time to the client excluded).
      for (const r of await many(db,
        `SELECT EXTRACT(EPOCH FROM (now() - created_at))::float8 * 1000 AS ms FROM room_events
          WHERE room_id = $1 AND seq > $2 AND created_at > now() - interval '30 seconds' ORDER BY seq LIMIT 100`, [roomId, cursor])) {
        observe('delivery_ms', Math.round(r.ms));
      }
      return {
        room: { id: room.id, status: room.status, last_seq: room.last_seq, ai_enabled: room.ai_enabled, moderation_level: room.room_type === 'private' ? room.moderation_level : null },
        events,
        cursor: rows.length ? rows[rows.length - 1].seq : cursor,
        presence: await presence(db, roomId),
        match_rev: await matchRev(db, room),
      };
    }
    if (pump) await pump(Math.min(4000, deadline - Date.now()));
    await waitForRoom(roomId, Math.max(50, Math.min(1000, deadline - Date.now())));
  }
}

// Room bootstrap for an active member: details plus a short recent window, never the full history.
export async function roomBootstrap(db, user, roomId) {
  let access;
  try {
    access = await roomAccess(db, roomId, user);
  } catch (err) {
    if (err instanceof RoomEndedError) {
      const room = await one(db, 'SELECT id, name, room_type, status, ended_at FROM rooms WHERE id = $1', [roomId]);
      return { room: { ...endedState(room), name: room?.name || null, room_type: room?.room_type }, items: [] };
    }
    throw err;
  }
  const { room, role, policy } = access;
  const window = config().rooms.historyWindow;
  const msgIds = (await many(db,
    `SELECT id FROM messages WHERE room_id = $1 AND (status IN ('visible', 'removed') OR (status = 'held' AND sender_id = $2))
      ORDER BY created_at DESC LIMIT $3`, [roomId, user.id, window])).map((r) => r.id);
  const pollIds = (await many(db, 'SELECT id FROM polls WHERE room_id = $1 ORDER BY created_at DESC LIMIT 5', [roomId])).map((r) => r.id);
  const insightIds = (await many(db, 'SELECT id FROM room_insights WHERE room_id = $1 ORDER BY seq DESC LIMIT 10', [roomId])).map((r) => r.id);
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
  const members = await many(db,
    `SELECT u.id, u.handle, u.display_name AS name, u.team, m.role FROM room_members m JOIN users u ON u.id = m.user_id
      WHERE m.room_id = $1 AND m.status = 'active' ORDER BY (m.role = 'owner') DESC, (m.role = 'admin') DESC, m.joined_at`, [roomId]);
  const cooldown = await one(db, 'SELECT next_allowed_at FROM user_send_cooldowns WHERE user_id = $1 AND next_allowed_at > now()', [user.id]);
  const match = room.match_id ? await one(db, 'SELECT id, title, status FROM matches WHERE id = $1', [room.match_id]) : null;
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
    items,
    cursor: room.last_seq,
    presence: await presence(db, roomId),
    cooldown_until: cooldown?.next_allowed_at || null,
    match_rev: await matchRev(db, room),
  };
}

export function parseAfter(value) {
  if (value === undefined) return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, 'invalid_cursor', 'after must be a non-negative integer.');
  return n;
}
