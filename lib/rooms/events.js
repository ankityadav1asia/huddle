// The per-room event log. Allocating the next sequence number also proves the room is still active:
// once a room ends, every write path that needs a sequence number fails atomically.
import { HttpError } from '../util.js';

export class RoomEndedError extends HttpError {
  constructor() {
    super(410, 'room_ended', 'This watch party has ended.');
  }
}

export async function nextSeq(q, roomId) {
  const row = (await q.query(
    `UPDATE rooms SET last_seq = last_seq + 1, updated_at = now() WHERE id = $1 AND status = 'active' RETURNING last_seq`,
    [roomId],
  )).rows[0];
  if (!row) throw new RoomEndedError();
  return row.last_seq;
}

export async function appendEvent(q, roomId, type, entityId, seq = null) {
  const s = seq ?? await nextSeq(q, roomId);
  await q.query('INSERT INTO room_events (room_id, seq, type, entity_id) VALUES ($1, $2, $3, $4)', [roomId, s, type, entityId]);
  return s;
}
