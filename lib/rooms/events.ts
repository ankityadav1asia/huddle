// The per-room event log. Allocating the next sequence number also proves the room is still active:
// once a room ends, every write path that needs a sequence number fails atomically.
import { HttpError } from '../util.ts';
import type { Queryable } from '../db/index.ts';

export class RoomEndedError extends HttpError {
  constructor() {
    super(410, 'room_ended', 'This watch party has ended.');
  }
}

export async function nextSeq(q: Queryable, roomId: string): Promise<number> {
  const row: { last_seq: number } | undefined = (await q.query(
    `UPDATE rooms SET last_seq = last_seq + 1, updated_at = now() WHERE id = $1 AND status = 'active' RETURNING last_seq`,
    [roomId],
  )).rows[0];
  if (!row) throw new RoomEndedError();
  return row.last_seq;
}

// What changed in the room; the event's entity_id is the id of that row (the room's own id for 'room').
export type RoomEventType = 'message' | 'message_update' | 'poll' | 'insight' | 'member' | 'thread' | 'room';

export async function appendEvent(q: Queryable, roomId: string, type: RoomEventType, entityId: string, seq: number | null = null) {
  const s = seq ?? await nextSeq(q, roomId);
  await q.query('INSERT INTO room_events (room_id, seq, type, entity_id) VALUES ($1, $2, $3, $4)', [roomId, s, type, entityId]);
  return s;
}
