// Polls: bounded creation (one open poll per room, idempotency key) and closing by a scheduled job.
import { config } from '../config.ts';
import { one, type Db } from '../db/index.ts';
import type { PollRow } from '../db/rows.ts';
import { newId, conflict } from '../util.ts';
import { nextSeq, appendEvent } from '../rooms/events.ts';
import { enqueue } from '../jobs/queue.ts';
import { notifyRoom } from '../realtime/bus.ts';

export interface NewPoll {
  question: string;
  options: string[];
  source: string;
  requestedBy?: string | null;
  idempotencyKey: string;
}

export async function createPoll(db: Db, roomId: string, { question, options, source, requestedBy = null, idempotencyKey }: NewPoll) {
  const seconds = config().cohost.pollSeconds;
  const out = await db.tx(async (q) => {
    const existing = await one<Pick<PollRow, 'id'>>(q, 'SELECT id FROM polls WHERE idempotency_key = $1', [idempotencyKey]);
    if (existing) return { id: existing.id, created: false };
    const open = await one<Pick<PollRow, 'id'>>(q, `SELECT id FROM polls WHERE room_id = $1 AND status = 'open' AND closes_at > now()`, [roomId]);
    if (open) throw conflict('There is already an open poll in this room.', 'poll_open');
    const seq = await nextSeq(q, roomId);
    const id = newId('pol');
    await q.query(
      `INSERT INTO polls (id, room_id, seq, question, options, source, requested_by, idempotency_key, status, closes_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, 'open', now() + make_interval(secs => $9))`,
      [id, roomId, seq, question, JSON.stringify(options.map((label) => ({ label }))), source, requestedBy, idempotencyKey, seconds]);
    await appendEvent(q, roomId, 'poll', id, seq);
    await enqueue(q, { type: 'poll_close', roomId, dedupeKey: `pollclose:${id}`, payload: { poll_id: id }, delaySeconds: seconds, priority: 3 });
    return { id, created: true };
  });
  if (out.created) notifyRoom(roomId);
  return out;
}

export async function closePoll(db: Db, pollId: string) {
  const roomId = await db.tx(async (q) => {
    const p = await one<Pick<PollRow, 'room_id'>>(q, `UPDATE polls SET status = 'closed' WHERE id = $1 AND status = 'open' RETURNING room_id`, [pollId]);
    if (!p) return null;
    await appendEvent(q, p.room_id, 'poll', pollId);
    return p.room_id;
  });
  if (roomId) notifyRoom(roomId);
  return Boolean(roomId);
}
