// Rooms, membership, roles and invitations. Authorization lives here, on the server, for every operation:
// the acting user comes from the session, room type and roles come from the database, and a private room
// is indistinguishable from a missing one for anyone who is not a member.
import { config } from '../config.ts';
import { one, many, type Db, type Queryable } from '../db/index.ts';
import type { MatchRow, ModerationLevel, RoomRole, RoomRow, UserRow } from '../db/rows.ts';
import type { SessionUser } from '../auth/sessions.ts';
import { HttpError, badRequest, notFound, forbidden, conflict, cleanText, isId, requireId, onlyKeys, newId, type RequestBody } from '../util.ts';
import { checkName } from '../moderation/classifier.ts';
import { LEVELS, effectivePolicy, POLICY_VERSION, type Policy } from '../moderation/policy.ts';
import { appendEvent, RoomEndedError } from './events.ts';
import { notifyRoom } from '../realtime/bus.ts';
import { enqueue } from '../jobs/queue.ts';
import { recordModeration } from '../moderation/audit.ts';
import { startMatchIfScheduled } from '../match/feed.ts';
import { createRoomReplay } from '../match/replay.ts';
import { fixtureFor, sportRank } from '../match/fixture.ts';

export type MemberStatus = 'active' | 'left' | 'removed';
type InvitationStatus = 'pending' | 'accepted' | 'declined' | 'expired' | 'revoked';

interface InvitationRow {
  id: string;
  room_id: string;
  inviter_id: string;
  invitee_id: string;
  status: InvitationStatus;
  created_at: Date;
  expires_at: Date;
  responded_at: Date | null;
}

// A room with the acting user's room_members row (a LEFT JOIN: role and status are both null without one).
type RoomWithMembership = RoomRow & (
  | { role: RoomRole; member_status: 'active' }
  | { role: RoomRole; member_status: 'left' | 'removed' }
  | { role: null; member_status: null });

// The room as an active member sees it, from roomAccess.
export type MemberRoom = RoomRow & { role: RoomRole; member_status: 'active' };
export interface RoomAccess { room: MemberRoom; role: RoomRole; policy: Policy }

export interface InviteResult {
  user_id: string;
  result: 'invited' | 'not_found' | 'already_member' | 'room_full' | 'already_invited';
  invitation_id?: string;
}

export const isAdminRole = (role: RoomRole) => role === 'owner' || role === 'admin';

// Central access check. Returns { room, role, policy } for an active member of an active room.
export async function roomAccess(q: Queryable, roomId: string, user: Pick<SessionUser, 'id'>, { allowEnded = false } = {}): Promise<RoomAccess> {
  if (!isId(roomId, 'room')) throw notFound('Room not found.');
  const room = await one<RoomWithMembership>(q,
    `SELECT r.*, m.role, m.status AS member_status FROM rooms r
       LEFT JOIN room_members m ON m.room_id = r.id AND m.user_id = $2
      WHERE r.id = $1`, [roomId, user.id]);
  if (!room) throw notFound('Room not found.');
  const member = room.member_status === 'active';
  if (!member) {
    // Knowing or guessing a private room id grants nothing, and reveals nothing.
    if (room.room_type === 'private') throw notFound('Room not found.');
    if (room.member_status === 'removed') throw forbidden('You were removed from this room.');
    if (room.status === 'active') throw new HttpError(403, 'join_required', 'Join this watch party first.');
    throw new RoomEndedError();
  }
  if (room.status !== 'active' && !allowEnded) throw new RoomEndedError();
  return { room, role: room.role, policy: effectivePolicy(room) };
}

// value: the invitee_ids the client sent, unchecked.
function parseInvitees(value: unknown, selfId: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw badRequest('invitee_ids must be a list.');
  const ids = [...new Set(value)];
  if (ids.length > config().rooms.maxInvitesPerRequest) throw badRequest(`Invite at most ${config().rooms.maxInvitesPerRequest} people at a time.`);
  for (const id of ids) requireId(id, 'usr', 'invitee_ids');
  return ids.filter((id) => id !== selfId);
}

async function inviteMany(q: Queryable, room: Pick<RoomRow, 'id'>, inviter: Pick<SessionUser, 'id'>, inviteeIds: string[]) {
  const cfg = config();
  const results: InviteResult[] = [];
  for (const inviteeId of inviteeIds) {
    const invitee = await one<Pick<UserRow, 'id' | 'handle'>>(q, 'SELECT id, handle FROM users WHERE id = $1 AND handle IS NOT NULL', [inviteeId]);
    if (!invitee) { results.push({ user_id: inviteeId, result: 'not_found' }); continue; }
    const member = await one<{ status: MemberStatus }>(q, `SELECT status FROM room_members WHERE room_id = $1 AND user_id = $2`, [room.id, inviteeId]);
    if (member?.status === 'active') { results.push({ user_id: inviteeId, result: 'already_member' }); continue; }
    const seats = await one<{ n: number }>(q,
      `SELECT (SELECT count(*)::int FROM room_members WHERE room_id = $1 AND status = 'active')
            + (SELECT count(*)::int FROM room_invitations WHERE room_id = $1 AND status = 'pending' AND expires_at > now()) AS n`,
      [room.id]);
    if (seats!.n >= cfg.rooms.maxMembers) { results.push({ user_id: inviteeId, result: 'room_full' }); continue; }
    await q.query(
      `UPDATE room_invitations SET status = 'expired' WHERE room_id = $1 AND invitee_id = $2 AND status = 'pending' AND expires_at <= now()`,
      [room.id, inviteeId]);
    const inv = await one<Pick<InvitationRow, 'id'>>(q,
      `INSERT INTO room_invitations (id, room_id, inviter_id, invitee_id, status, expires_at)
       VALUES ($1, $2, $3, $4, 'pending', now() + make_interval(hours => $5))
       ON CONFLICT (room_id, invitee_id) WHERE status = 'pending' DO NOTHING
       RETURNING id`,
      [newId('inv'), room.id, inviter.id, inviteeId, cfg.rooms.inviteTtlHours]);
    if (!inv) { results.push({ user_id: inviteeId, result: 'already_invited' }); continue; }
    // Invitation alert: in-app (the invitee's home list) and, if they opted in, a generic push.
    await enqueue(q, { type: 'push_invite', dedupeKey: `invite:${inv.id}`, payload: { invitation_id: inv.id }, priority: 4, expiresInSeconds: 3600 });
    results.push({ user_id: inviteeId, result: 'invited', invitation_id: inv.id });
  }
  return results;
}

// own_replay: the room gets its own copy of the match's simulated replay, which its owner and admins control
// (lib/rooms/replay.js). Without it the room follows the shared replay, like the public watch party.
export async function createPrivateRoom(db: Db, user: SessionUser, body: RequestBody) {
  onlyKeys(body, ['name', 'match_id', 'own_replay', 'moderation_level', 'invitee_ids', 'ai_enabled']);
  const name = cleanText(body.name, { max: 40, field: 'Room name' });
  if (!checkName(name)) throw badRequest('Choose a different room name.', 'name_rejected');
  const level = body.moderation_level ?? 'balanced';
  if (!LEVELS.includes(level)) throw badRequest('Moderation must be relaxed, balanced or strict.', 'invalid_moderation_level');
  if (body.ai_enabled !== undefined && typeof body.ai_enabled !== 'boolean') throw badRequest('ai_enabled must be true or false.');
  if (body.own_replay !== undefined && typeof body.own_replay !== 'boolean') throw badRequest('own_replay must be true or false.');
  let matchId: string | null = null;
  let shared: Pick<MatchRow, 'id' | 'status' | 'fixture_key'> | null = null;
  if (body.match_id !== undefined && body.match_id !== null) {
    requireId(body.match_id, 'mat', 'match_id');
    shared = await one<Pick<MatchRow, 'id' | 'status' | 'fixture_key'>>(db, 'SELECT id, status, fixture_key FROM matches WHERE id = $1 AND room_id IS NULL', [body.match_id]);
    if (!shared || (shared.status === 'completed' && !body.own_replay)) throw badRequest('That match is not available.', 'invalid_match');
    if (!body.own_replay) matchId = shared.id;
  } else if (body.own_replay) {
    throw badRequest('Pick a match for the room to replay.', 'invalid_match');
  }
  const invitees = parseInvitees(body.invitee_ids, user.id);

  const out = await db.tx(async (q) => {
    const owned = await one<{ n: number }>(q, `SELECT count(*)::int AS n FROM rooms WHERE creator_id = $1 AND status = 'active'`, [user.id]);
    const cap = config().rooms.maxActiveOwned;
    if (owned!.n >= cap) throw conflict(`You already have ${cap} active private rooms. End one first.`, 'room_limit');
    // INSERT ... RETURNING always returns the new row.
    const room = (await one<RoomRow>(q,
      `INSERT INTO rooms (id, name, room_type, creator_id, match_id, moderation_level, ai_enabled)
       VALUES ($1, $2, 'private', $3, $4, $5, $6) RETURNING *`,
      [newId('room'), name, user.id, matchId, level, body.ai_enabled ?? true]))!;
    if (shared && body.own_replay) {
      // Waits for the host to press Start, so friends can arrive first.
      await q.query('UPDATE rooms SET match_id = $2 WHERE id = $1', [room.id, await createRoomReplay(q, room.id, shared.fixture_key)]);
    }
    await q.query(`INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'owner')`, [room.id, user.id]);
    await appendEvent(q, room.id, 'member', user.id);
    await recordModeration(q, { roomId: room.id, actorId: user.id, eventType: 'policy_set', severity: 'low', level, action: 'room_created' });
    const invitations = await inviteMany(q, room, user, invitees);
    return { room_id: room.id, invitations };
  });
  if (matchId) await startMatchIfScheduled(db, matchId);
  return out;
}

export async function inviteToRoom(db: Db, user: SessionUser, roomId: string, body: RequestBody) {
  onlyKeys(body, ['invitee_ids']);
  const result = await db.tx(async (q) => {
    const { room, role } = await roomAccess(q, roomId, user);
    if (room.room_type !== 'private') throw forbidden('Public rooms do not use invitations.');
    if (!isAdminRole(role)) throw forbidden('Only the room owner or an admin can invite people.');
    const ids = parseInvitees(body.invitee_ids, user.id);
    if (!ids.length) throw badRequest('Pick at least one person to invite.');
    return inviteMany(q, room, user, ids);
  });
  return { invitations: result };
}

// An invitation as the room's owner and admins list it, with the invitee's profile.
type RoomInvitationRow = Pick<InvitationRow, 'id' | 'status' | 'created_at' | 'expires_at' | 'responded_at'>
  & { user_id: string; handle: string | null; display_name: string | null; lapsed: boolean };

export async function roomInvitations(db: Queryable, user: SessionUser, roomId: string) {
  const { room, role } = await roomAccess(db, roomId, user);
  if (room.room_type !== 'private' || !isAdminRole(role)) throw forbidden('Only the room owner or an admin can see invitations.');
  const rows = await many<RoomInvitationRow>(db,
    `SELECT i.id, i.status, i.created_at, i.expires_at, i.responded_at, u.id AS user_id, u.handle, u.display_name,
            (i.status = 'pending' AND i.expires_at <= now()) AS lapsed
       FROM room_invitations i JOIN users u ON u.id = i.invitee_id
      WHERE i.room_id = $1 ORDER BY i.created_at DESC LIMIT 100`, [roomId]);
  return { invitations: rows.map(({ lapsed, ...r }) => ({ ...r, status: lapsed ? 'expired' : r.status })) };
}

// A pending invitation as its invitee sees it.
interface MyInvitationRow {
  id: string;
  expires_at: Date;
  created_at: Date;
  room_id: string;
  room_name: string | null;
  moderation_level: ModerationLevel | null;
  inviter_handle: string | null;
  inviter_name: string | null;
  match_title: string | null;
}

export async function myInvitations(db: Queryable, user: SessionUser) {
  const rows = await many<MyInvitationRow>(db,
    `SELECT i.id, i.expires_at, i.created_at, r.id AS room_id, r.name AS room_name, r.moderation_level,
            inv.handle AS inviter_handle, inv.display_name AS inviter_name, mt.title AS match_title
       FROM room_invitations i
       JOIN rooms r ON r.id = i.room_id
       JOIN users inv ON inv.id = i.inviter_id
       LEFT JOIN matches mt ON mt.id = r.match_id
      WHERE i.invitee_id = $1 AND i.status = 'pending' AND i.expires_at > now() AND r.status = 'active'
      ORDER BY i.created_at DESC LIMIT 50`, [user.id]);
  return { invitations: rows };
}

// action: what the client asked for, checked here ('accept' or 'decline').
export async function respondToInvitation(db: Db, user: SessionUser, invitationId: string, action: string) {
  if (!['accept', 'decline'].includes(action)) throw badRequest('Choose accept or decline.');
  if (!isId(invitationId, 'inv')) throw notFound('Invitation not found.');
  const out = await db.tx(async (q) => {
    const inv = await one<InvitationRow & { room_status: RoomRow['status']; lapsed: boolean }>(q,
      `SELECT i.*, r.status AS room_status, (i.expires_at <= now()) AS lapsed
         FROM room_invitations i JOIN rooms r ON r.id = i.room_id
        WHERE i.id = $1 AND i.invitee_id = $2 FOR UPDATE OF i`, [invitationId, user.id]);
    // Someone else's invitation looks exactly like a missing one.
    if (!inv) throw notFound('Invitation not found.');
    if (inv.status !== 'pending') throw conflict(`This invitation was already ${inv.status}.`, `invitation_${inv.status}`);
    if (inv.lapsed || inv.room_status !== 'active') {
      await q.query(`UPDATE room_invitations SET status = 'expired' WHERE id = $1`, [inv.id]);
      return { expired: true };
    }
    if (action === 'decline') {
      await q.query(`UPDATE room_invitations SET status = 'declined', responded_at = now() WHERE id = $1`, [inv.id]);
      return { status: 'declined' };
    }
    const members = await one<{ n: number }>(q, `SELECT count(*)::int AS n FROM room_members WHERE room_id = $1 AND status = 'active'`, [inv.room_id]);
    if (members!.n >= config().rooms.maxMembers) throw conflict('This room is full.', 'room_full');
    await q.query(
      `INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'member')
       ON CONFLICT (room_id, user_id) DO UPDATE
         SET status = 'active', role = CASE WHEN room_members.role = 'owner' THEN 'owner' ELSE 'member' END,
             joined_at = now(), left_at = NULL`,
      [inv.room_id, user.id]);
    await q.query(`UPDATE room_invitations SET status = 'accepted', responded_at = now() WHERE id = $1`, [inv.id]);
    await appendEvent(q, inv.room_id, 'member', user.id);
    return { status: 'accepted', room_id: inv.room_id };
  });
  if (out.expired) throw new HttpError(410, 'invitation_expired', 'This invitation has expired.');
  if (out.room_id) notifyRoom(out.room_id);
  return out;
}

export async function revokeInvitation(db: Db, user: SessionUser, invitationId: string) {
  if (!isId(invitationId, 'inv')) throw notFound('Invitation not found.');
  const out = await db.tx(async (q) => {
    const inv = await one<InvitationRow>(q, 'SELECT * FROM room_invitations WHERE id = $1 FOR UPDATE', [invitationId]);
    if (!inv) throw notFound('Invitation not found.');
    const { role } = await roomAccess(q, inv.room_id, user);
    if (!isAdminRole(role)) throw notFound('Invitation not found.');
    if (inv.status !== 'pending') throw conflict(`This invitation was already ${inv.status}.`, `invitation_${inv.status}`);
    await q.query(`UPDATE room_invitations SET status = 'revoked', responded_at = now() WHERE id = $1`, [inv.id]);
    return { status: 'revoked' };
  });
  return out;
}

export async function joinPublicRoom(db: Db, user: SessionUser, roomId: string) {
  if (!isId(roomId, 'room')) throw notFound('Room not found.');
  const out = await db.tx(async (q) => {
    const room = await one<RoomRow>(q, 'SELECT * FROM rooms WHERE id = $1 FOR UPDATE', [roomId]);
    if (!room || room.room_type !== 'public') throw notFound('Room not found.');
    if (room.status !== 'active') throw new RoomEndedError();
    const existing = await one<{ status: MemberStatus }>(q, 'SELECT status FROM room_members WHERE room_id = $1 AND user_id = $2', [roomId, user.id]);
    if (existing?.status === 'removed') throw forbidden('You were removed from this room.');
    if (existing?.status === 'active') return { joined: false, match_id: room.match_id };
    // The room row is locked above, so concurrent joins cannot push it past the cap.
    const cap = config().rooms.publicMaxMembers;
    const members = await one<{ n: number }>(q, `SELECT count(*)::int AS n FROM room_members WHERE room_id = $1 AND status = 'active'`, [roomId]);
    if (members!.n >= cap) throw conflict(`This watch party is full (${cap} members).`, 'room_full');
    await q.query(
      `INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'member')
       ON CONFLICT (room_id, user_id) DO UPDATE SET status = 'active', role = 'member', joined_at = now(), left_at = NULL`,
      [roomId, user.id]);
    await appendEvent(q, roomId, 'member', user.id);
    return { joined: true, match_id: room.match_id };
  });
  if (out.joined) notifyRoom(roomId);
  if (out.match_id) await startMatchIfScheduled(db, out.match_id);
  return { room_id: roomId };
}

export async function leaveRoom(db: Db, user: SessionUser, roomId: string) {
  await db.tx(async (q) => {
    const { role } = await roomAccess(q, roomId, user);
    if (role === 'owner') throw conflict('As the owner, end the watch party instead of leaving it.', 'owner_cannot_leave');
    await q.query(`UPDATE room_members SET status = 'left', left_at = now() WHERE room_id = $1 AND user_id = $2`, [roomId, user.id]);
    await q.query('DELETE FROM room_presence WHERE room_id = $1 AND user_id = $2', [roomId, user.id]);
    await appendEvent(q, roomId, 'member', user.id);
  });
  notifyRoom(roomId);
  return { left: true };
}

export async function setMemberRole(db: Db, user: SessionUser, roomId: string, targetId: string, body: RequestBody) {
  onlyKeys(body, ['role']);
  if (!['admin', 'member'].includes(body.role)) throw badRequest('Role must be admin or member.', 'invalid_role');
  await db.tx(async (q) => {
    const { room, role } = await roomAccess(q, roomId, user);
    if (room.room_type !== 'private' || role !== 'owner') throw forbidden('Only the room owner can change roles.');
    if (targetId === user.id) throw forbidden('You cannot change your own role.');
    const target = await one<{ role: RoomRole }>(q, `SELECT role FROM room_members WHERE room_id = $1 AND user_id = $2 AND status = 'active' FOR UPDATE`, [roomId, targetId]);
    if (!target) throw notFound('That person is not in this room.');
    await q.query('UPDATE room_members SET role = $3 WHERE room_id = $1 AND user_id = $2', [roomId, targetId, body.role]);
    await appendEvent(q, roomId, 'member', targetId);
  });
  notifyRoom(roomId);
  return { role: body.role };
}

export async function removeMember(db: Db, user: SessionUser, roomId: string, targetId: string) {
  await db.tx(async (q) => {
    const { role } = await roomAccess(q, roomId, user);
    if (!isAdminRole(role)) throw forbidden('Only the room owner or an admin can remove people.');
    if (targetId === user.id) throw badRequest('Use leave to exit the room.');
    const target = await one<{ role: RoomRole }>(q, `SELECT role FROM room_members WHERE room_id = $1 AND user_id = $2 AND status = 'active' FOR UPDATE`, [roomId, targetId]);
    if (!target) throw notFound('That person is not in this room.');
    if (target.role === 'owner' || (target.role === 'admin' && role !== 'owner')) throw forbidden('You cannot remove this person.');
    await q.query(`UPDATE room_members SET status = 'removed', left_at = now() WHERE room_id = $1 AND user_id = $2`, [roomId, targetId]);
    await q.query('DELETE FROM room_presence WHERE room_id = $1 AND user_id = $2', [roomId, targetId]);
    await appendEvent(q, roomId, 'member', targetId);
    await recordModeration(q, { roomId, actorId: user.id, targetUserId: targetId, eventType: 'member_removed', severity: 'medium', action: 'removed_by_room_admin' });
  });
  notifyRoom(roomId);
  return { removed: true };
}

// Private rooms only, owner/admin only. Public moderation is never user-configurable.
export async function updateRoomSettings(db: Db, user: SessionUser, roomId: string, body: RequestBody) {
  onlyKeys(body, ['moderation_level', 'ai_enabled']);
  const out = await db.tx(async (q) => {
    const { room, role } = await roomAccess(q, roomId, user);
    if (room.room_type === 'public') throw forbidden('Moderation and safety settings for public rooms are managed by Huddle.');
    if (!isAdminRole(role)) throw forbidden('Only the room owner or an admin can change room settings.');
    const level = body.moderation_level ?? room.moderation_level;
    if (!LEVELS.includes(level)) throw badRequest('Moderation must be relaxed, balanced or strict.', 'invalid_moderation_level');
    if (body.ai_enabled !== undefined && typeof body.ai_enabled !== 'boolean') throw badRequest('ai_enabled must be true or false.');
    const ai = body.ai_enabled ?? room.ai_enabled;
    await q.query('UPDATE rooms SET moderation_level = $2, ai_enabled = $3, updated_at = now() WHERE id = $1', [roomId, level, ai]);
    if (level !== room.moderation_level) {
      await recordModeration(q, { roomId, actorId: user.id, eventType: 'policy_changed', severity: 'low', level, action: `level_${room.moderation_level}_to_${level}` });
    }
    await appendEvent(q, roomId, 'room', roomId);
    return { moderation_level: level, ai_enabled: ai };
  });
  notifyRoom(roomId);
  return out;
}

// A public watch party on the home list, with its match and how many people are in it.
type PublicRoomRow = Pick<RoomRow, 'id' | 'name' | 'status' | 'match_id'> & Pick<MatchRow, 'fixture_key'>
  & { match_title: string; match_status: MatchRow['status']; members: number; online: number; joined: boolean };
// One of the viewer's private rooms on the home list.
type MyRoomRow = Pick<RoomRow, 'id' | 'name' | 'room_type' | 'status' | 'moderation_level' | 'ended_at'>
  & { role: RoomRole; match_title: string | null; members: number; online: number };

export async function listRooms(db: Queryable, user: SessionUser) {
  // One public watch party per match that is live or upcoming. Rooms of finished matches close on their own
  // a few minutes after the result and are no longer offered.
  const cap = config().rooms.publicMaxMembers;
  const publicRooms = (await many<PublicRoomRow>(db,
    `SELECT r.id, r.name, r.status, r.match_id, mt.title AS match_title, mt.status AS match_status, mt.fixture_key,
            (SELECT count(*)::int FROM room_members m WHERE m.room_id = r.id AND m.status = 'active') AS members,
            (SELECT count(*)::int FROM room_presence p WHERE p.room_id = r.id AND p.last_seen_at > now() - interval '45 seconds') AS online,
            EXISTS (SELECT 1 FROM room_members m WHERE m.room_id = r.id AND m.user_id = $1 AND m.status = 'active') AS joined
       FROM rooms r JOIN matches mt ON mt.id = r.match_id
      WHERE r.room_type = 'public' AND r.status = 'active' AND mt.status IN ('scheduled', 'live')
      ORDER BY r.created_at DESC LIMIT 10`, [user.id]))
    .sort((a, b) => sportRank(a.fixture_key) - sportRank(b.fixture_key)) // one per sport: cricket, F1, basketball, hockey
    .map(({ fixture_key: key, ...r }) => ({ ...r, sport: fixtureFor({ fixture_key: key }).sport, max_members: cap, full: r.members >= cap && !r.joined }));
  const mine = await many<MyRoomRow>(db,
    `SELECT r.id, r.name, r.room_type, r.status, r.moderation_level, r.ended_at, m.role, mt.title AS match_title,
            (SELECT count(*)::int FROM room_members x WHERE x.room_id = r.id AND x.status = 'active') AS members,
            (SELECT count(*)::int FROM room_presence p WHERE p.room_id = r.id AND p.last_seen_at > now() - interval '45 seconds') AS online
       FROM room_members m JOIN rooms r ON r.id = m.room_id LEFT JOIN matches mt ON mt.id = r.match_id
      WHERE m.user_id = $1 AND m.status = 'active' AND r.room_type = 'private' AND r.status IN ('active', 'ended')
      ORDER BY (r.status = 'active') DESC, r.updated_at DESC LIMIT 20`, [user.id]);
  return { public_rooms: publicRooms, my_rooms: mine };
}

export { RoomEndedError, POLICY_VERSION };
