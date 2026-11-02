// Reactions (allowlisted emoji only) and poll votes. Both are idempotent "set" operations.
import { one } from '../db/index.js';
import { badRequest, notFound, conflict, onlyKeys, requireId } from '../util.js';
import { roomAccess } from '../rooms/service.js';
import { appendEvent } from '../rooms/events.js';
import { notifyRoom } from '../realtime/bus.js';
import { requireToken } from '../limits.js';
import { config } from '../config.js';
import { REACTIONS } from './hydrate.js';

export async function setReaction(db, user, roomId, messageId, body) {
  onlyKeys(body, ['emoji', 'on']);
  if (!REACTIONS.includes(body.emoji)) throw badRequest('That reaction is not available.', 'invalid_reaction');
  if (typeof body.on !== 'boolean') throw badRequest('on must be true or false.');
  requireId(messageId, 'msg', 'message');
  await roomAccess(db, roomId, user);
  await requireToken(db, `react:${user.id}`, { limit: config().chat.reactionsPerMinute, windowSeconds: 60 }, 'Slow down on the reactions.');
  const changed = await db.tx(async (q) => {
    const msg = await one(q, `SELECT id FROM messages WHERE id = $1 AND room_id = $2 AND status = 'visible'`, [messageId, roomId]);
    if (!msg) throw notFound('Message not found.');
    const res = body.on
      ? await q.query('INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING message_id', [messageId, user.id, body.emoji])
      : await q.query('DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3 RETURNING message_id', [messageId, user.id, body.emoji]);
    if (!res.rows.length) return false;
    await appendEvent(q, roomId, 'message_update', messageId);
    return true;
  });
  if (changed) notifyRoom(roomId);
  return { ok: true };
}

export async function votePoll(db, user, roomId, pollId, body) {
  onlyKeys(body, ['option']);
  requireId(pollId, 'pol', 'poll');
  if (!Number.isInteger(body.option)) throw badRequest('Pick an option.');
  await roomAccess(db, roomId, user);
  const changed = await db.tx(async (q) => {
    const poll = await one(q, `SELECT id, options, status, closes_at > now() AS live FROM polls WHERE id = $1 AND room_id = $2`, [pollId, roomId]);
    if (!poll) throw notFound('Poll not found.');
    if (poll.status !== 'open' || !poll.live) throw conflict('This poll has closed.', 'poll_closed');
    if (body.option < 0 || body.option >= poll.options.length) throw badRequest('Pick one of the options.');
    const res = await q.query(
      `INSERT INTO poll_votes (poll_id, user_id, option_index) VALUES ($1, $2, $3)
       ON CONFLICT (poll_id, user_id) DO UPDATE SET option_index = EXCLUDED.option_index, created_at = now()
       WHERE poll_votes.option_index <> EXCLUDED.option_index RETURNING poll_id`,
      [pollId, user.id, body.option]);
    if (!res.rows.length) return false;
    await appendEvent(q, roomId, 'poll', pollId);
    return true;
  });
  if (changed) notifyRoom(roomId);
  return { ok: true };
}
