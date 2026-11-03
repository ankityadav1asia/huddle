// Replay controls for a private room that runs its own copy of the simulated replay (POST /api/rooms/:id/replay).
// Only the room's owner and admins may use them, and they only ever move that room's own run: the public watch
// party and rooms following the shared replay have no controls.
import { one, type Db } from '../db/index.ts';
import type { MatchRow } from '../db/rows.ts';
import type { SessionUser } from '../auth/sessions.ts';
import { badRequest, conflict, forbidden, onlyKeys, type RequestBody } from '../util.ts';
import { requireToken } from '../limits.ts';
import { roomAccess, isAdminRole } from './service.ts';
import { notifyRoom } from '../realtime/bus.ts';
import { log } from '../log.ts';
import {
  SPEEDS, startReplay, pauseReplay, resumeReplay, setReplaySpeed, restartReplay, momentNeedsRestart, jumpReplay,
} from '../match/replay.ts';

const ACTIONS = ['start', 'pause', 'resume', 'speed', 'restart', 'jump'];
const RESTARTS_PER_HOUR = 6;

export async function controlRoomReplay(db: Db, user: SessionUser, roomId: string, body: RequestBody) {
  onlyKeys(body, ['action', 'speed', 'moment']);
  if (!ACTIONS.includes(body.action)) throw badRequest(`action must be one of: ${ACTIONS.join(', ')}.`, 'invalid_action');
  if (body.action === 'speed' && !SPEEDS.includes(body.speed)) throw badRequest('speed must be 0.5, 1 or 2.', 'invalid_speed');
  if (body.action === 'jump' && typeof body.moment !== 'string') throw badRequest('Pick a moment.', 'invalid_moment');

  const { room, role } = await roomAccess(db, roomId, user);
  if (room.room_type !== 'private') throw forbidden('The public watch party follows the shared replay, which nobody can pause or move.');
  if (!isAdminRole(role)) throw forbidden('Only the room owner or an admin can control the replay.');
  const m = room.match_id ? await one<MatchRow>(db, 'SELECT * FROM matches WHERE id = $1', [room.match_id]) : null;
  if (!m || m.room_id !== room.id) throw conflict('This room follows the shared replay, so it has no replay controls.', 'not_controllable');
  await requireToken(db, `replay:${room.id}`, { limit: 30, windowSeconds: 60 }, 'Slow down a little.');
  // Each restart is a new run; capping them keeps a room from replaying big moments (and their alerts) on a loop.
  const restarts = body.action === 'restart' || (body.action === 'jump' && (await momentNeedsRestart(db, m, body.moment)));
  if (restarts) {
    await requireToken(db, `replay_restart:${room.id}`, { limit: RESTARTS_PER_HOUR, windowSeconds: 3600 },
      `The replay can be restarted ${RESTARTS_PER_HOUR} times an hour. Try again later.`);
  }

  let out = { ok: true };
  if (body.action === 'start') await startReplay(db, m);
  else if (body.action === 'pause') await pauseReplay(db, m);
  else if (body.action === 'resume') await resumeReplay(db, m);
  else if (body.action === 'speed') await setReplaySpeed(db, m.id, body.speed);
  else if (body.action === 'restart') await restartReplay(db, room.id, m);
  else out = { ok: true, ...(await jumpReplay(db, room.id, m, body.moment)) };
  notifyRoom(room.id); // members' long-polls pick up the new replay state straight away
  log.info('replay.control', { room: room.id, action: body.action, restarted: restarts });
  return out;
}
