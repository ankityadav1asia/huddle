// Room lifecycle: active -> ended -> purged. Ending is one atomic transition: from that instant every read of
// room history is refused, writes fail (sequence allocation requires an active room), queued room jobs are
// cancelled and pending alerts expire. Message bodies are deleted later by the idempotent purge job, after the
// configured retention window (MESSAGE_RETENTION_HOURS, default 24h).
import { config } from '../config.ts';
import { one, type Db } from '../db/index.ts';
import type { RoomRow } from '../db/rows.ts';
import type { SessionUser } from '../auth/sessions.ts';
import { forbidden } from '../util.ts';
import { cancelRoomJobs, enqueue } from '../jobs/queue.ts';
import { notifyRoom } from '../realtime/bus.ts';
import { recordModeration } from '../moderation/audit.ts';
import { roomAccess } from './service.ts';
import { clearRoomContext } from '../ai/context-cache.ts';

export async function endRoom(db: Db, roomId: string, { reason, actorId = null }: { reason: string; actorId?: string | null }) {
  const ended = await db.tx(async (q) => {
    const row = await one<Pick<RoomRow, 'id' | 'purge_after'>>(q,
      `UPDATE rooms SET status = 'ended', ended_at = now(), end_reason = $2, updated_at = now(),
              purge_after = now() + make_interval(hours => $3)
        WHERE id = $1 AND status = 'active' RETURNING id, purge_after`,
      [roomId, reason, config().retention.messageHours]);
    if (!row) return false;
    await cancelRoomJobs(q, roomId);
    await q.query(`UPDATE room_invitations SET status = 'expired' WHERE room_id = $1 AND status = 'pending'`, [roomId]);
    await q.query(`UPDATE notification_deliveries SET status = 'expired' WHERE room_id = $1 AND status = 'queued'`, [roomId]);
    await q.query('DELETE FROM room_presence WHERE room_id = $1', [roomId]);
    // The purge job is not room-scoped on purpose: closing a room cancels room jobs, never its own clean-up.
    await enqueue(q, {
      type: 'room_purge', dedupeKey: `purge:${roomId}`, payload: { room_id: roomId },
      delaySeconds: config().retention.messageHours * 3600, priority: 8, maxAttempts: 5,
    });
    await recordModeration(q, { roomId, actorId, eventType: 'room_ended', severity: 'low', action: reason });
    return true;
  });
  if (ended) {
    clearRoomContext(roomId);
    notifyRoom(roomId);
  }
  return ended;
}

export async function endRoomByUser(db: Db, user: SessionUser, roomId: string) {
  const { room, role } = await roomAccess(db, roomId, user);
  const allowed = room.room_type === 'private' ? role === 'owner' : user.is_moderator;
  if (!allowed) throw forbidden(room.room_type === 'private' ? 'Only the room owner can end this watch party.' : 'Public watch parties are ended by Huddle.');
  await endRoom(db, roomId, { reason: room.room_type === 'private' ? 'ended_by_owner' : 'ended_by_moderator', actorId: user.id });
  return { status: 'ended' };
}

// Deletes room content after the retention window. Safe to run any number of times.
export async function purgeRoom(db: Db, roomId: string): Promise<'purged' | 'already_purged' | 'not_ended'> {
  return db.tx(async (q) => {
    const room = await one<Pick<RoomRow, 'status'>>(q, 'SELECT status FROM rooms WHERE id = $1 FOR UPDATE', [roomId]);
    if (!room || room.status === 'purged') return 'already_purged';
    if (room.status !== 'ended') return 'not_ended';
    await q.query('DELETE FROM room_events WHERE room_id = $1', [roomId]);
    await q.query('DELETE FROM room_insights WHERE room_id = $1', [roomId]);
    await q.query('DELETE FROM polls WHERE room_id = $1', [roomId]);
    await q.query(`UPDATE reports SET status = CASE WHEN status = 'open' THEN 'dismissed' ELSE status END, note = NULL WHERE room_id = $1`, [roomId]);
    await q.query('DELETE FROM messages WHERE room_id = $1', [roomId]);
    await q.query('DELETE FROM room_threads WHERE room_id = $1', [roomId]);
    await q.query('DELETE FROM room_presence WHERE room_id = $1', [roomId]);
    await q.query(`UPDATE rooms SET status = 'purged', name = NULL, updated_at = now() WHERE id = $1`, [roomId]);
    return 'purged';
  });
}
