// Reporting, human review and appeals. Three distinct reports hide a message until a moderator reviews it.
// Moderators (MODERATOR_USER_IDS, listed by account id) see only queued items, not whole private rooms.
// Automated decisions never ban anyone; only a human can remove content.
import { one, many, type Db, type Queryable } from '../db/index.ts';
import type { MessageRow, RoomRow, RoomType } from '../db/rows.ts';
import type { SessionUser } from '../auth/sessions.ts';
import { HttpError, badRequest, notFound, forbidden, conflict, onlyKeys, requireId, cleanText, newId, type RequestBody } from '../util.ts';
import { roomAccess } from '../rooms/service.ts';
import { nextSeq, appendEvent, RoomEndedError } from '../rooms/events.ts';
import { notifyRoom } from '../realtime/bus.ts';
import { recordModeration, type ModerationEventRow } from './audit.ts';

const REASONS = ['harassment', 'hate', 'threat', 'spam', 'personal_info', 'sexual', 'misinformation', 'other'];

// reports: a member's report of a message or AI response, or an appeal of an automated decision.
interface ReportRow {
  id: string;
  kind: 'message' | 'ai_response' | 'appeal';
  room_id: string | null;
  reporter_id: string;
  message_id: string | null;
  moderation_event_id: string | null;
  reason: string;
  note: string | null;
  status: 'open' | 'dismissed' | 'actioned';
  created_at: Date;
  resolved_by: string | null;
  resolved_at: Date | null;
}

// The moderator queue: held messages, and open reports with the message they are about (none for an appeal).
type HeldMessage = Pick<MessageRow, 'id' | 'room_id' | 'body' | 'sender_type' | 'created_at' | 'moderation'>
  & { handle: string | null; room_type: RoomType; room_status: RoomRow['status']; reports: number };
type QueuedReport = Pick<ReportRow, 'id' | 'kind' | 'reason' | 'note' | 'created_at' | 'room_id' | 'message_id' | 'moderation_event_id'>
  & { body: string | null; message_status: MessageRow['status'] | null; sender_type: MessageRow['sender_type'] | null; author_handle: string | null };

export async function reportMessage(db: Db, user: SessionUser, roomId: string, messageId: string, body: RequestBody) {
  onlyKeys(body, ['reason', 'note']);
  requireId(messageId, 'msg', 'message');
  if (!REASONS.includes(body.reason)) throw badRequest('Pick a reason.', 'invalid_reason');
  const note = body.note ? cleanText(body.note, { max: 200, field: 'Note' }) : null;
  await roomAccess(db, roomId, user);
  const out = await db.tx(async (q) => {
    const msg = await one<Pick<MessageRow, 'id' | 'sender_type' | 'sender_id' | 'status'>>(q,
      `SELECT id, sender_type, sender_id, status FROM messages WHERE id = $1 AND room_id = $2 FOR UPDATE`, [messageId, roomId]);
    if (!msg || msg.status !== 'visible') throw notFound('Message not found.');
    if (msg.sender_id === user.id) throw badRequest('You cannot report your own message.');
    const created = await one<Pick<ReportRow, 'id'>>(q,
      `INSERT INTO reports (id, kind, room_id, reporter_id, message_id, reason, note, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'open') ON CONFLICT (reporter_id, message_id) WHERE message_id IS NOT NULL DO NOTHING RETURNING id`,
      [newId('rep'), msg.sender_type === 'ai' ? 'ai_response' : 'message', roomId, user.id, messageId, body.reason, note]);
    if (!created) throw conflict('You already reported this message.', 'already_reported');
    await recordModeration(q, { roomId, actorId: user.id, targetUserId: msg.sender_id, messageId, eventType: 'report_created', severity: 'medium', categories: [body.reason], action: 'queued_for_review' });
    const count = (await one<{ n: number }>(q, `SELECT count(*)::int AS n FROM reports WHERE message_id = $1 AND status = 'open'`, [messageId]))!; // count(*) always returns a row
    if (count.n >= 3) {
      // Hidden pending human review (reversible), never deleted automatically.
      await q.query(`UPDATE messages SET status = 'held' WHERE id = $1`, [messageId]);
      await appendEvent(q, roomId, 'message_update', messageId);
      await recordModeration(q, { roomId, targetUserId: msg.sender_id, messageId, eventType: 'message_hidden', severity: 'medium', categories: ['reports'], action: 'hidden_pending_review' });
      return { hidden: true };
    }
    return { hidden: false };
  });
  if (out.hidden) notifyRoom(roomId);
  return { reported: true, hidden: out.hidden };
}

// Appeal of an automated decision about one's own message.
export async function appeal(db: Queryable, user: SessionUser, body: RequestBody) {
  onlyKeys(body, ['moderation_event_id', 'note']);
  requireId(body.moderation_event_id, 'mod', 'moderation_event_id');
  const note = body.note ? cleanText(body.note, { max: 300, field: 'Note' }) : null;
  const ev = await one<Pick<ModerationEventRow, 'id' | 'room_id' | 'target_user_id' | 'actor_id'>>(db,
    'SELECT id, room_id, target_user_id, actor_id FROM moderation_events WHERE id = $1', [body.moderation_event_id]);
  if (!ev || ev.target_user_id !== user.id || ev.actor_id !== null) throw notFound('Decision not found.');
  const row = await one<Pick<ReportRow, 'id'>>(db,
    `INSERT INTO reports (id, kind, room_id, reporter_id, moderation_event_id, reason, note, status)
     SELECT $1, 'appeal', $2, $3, $4, 'other', $5, 'open'
      WHERE NOT EXISTS (SELECT 1 FROM reports WHERE kind = 'appeal' AND moderation_event_id = $4) RETURNING id`,
    [newId('rep'), ev.room_id, user.id, ev.id, note]);
  if (!row) throw conflict('You already appealed this decision.', 'already_appealed');
  return { appealed: true };
}

export async function moderationQueue(db: Queryable, user: SessionUser) {
  if (!user.is_moderator) throw forbidden('Moderators only.');
  const held = await many<HeldMessage>(db,
    `SELECT m.id, m.room_id, m.body, m.sender_type, m.created_at, m.moderation, u.handle, r.room_type, r.status AS room_status,
            (SELECT count(*)::int FROM reports x WHERE x.message_id = m.id AND x.status = 'open') AS reports
       FROM messages m LEFT JOIN users u ON u.id = m.sender_id JOIN rooms r ON r.id = m.room_id
      WHERE m.status = 'held' AND r.status = 'active' ORDER BY m.created_at LIMIT 50`);
  const reports = await many<QueuedReport>(db,
    `SELECT rp.id, rp.kind, rp.reason, rp.note, rp.created_at, rp.room_id, rp.message_id, rp.moderation_event_id,
            m.body, m.status AS message_status, m.sender_type, u.handle AS author_handle
       FROM reports rp LEFT JOIN messages m ON m.id = rp.message_id LEFT JOIN users u ON u.id = m.sender_id
      WHERE rp.status = 'open' ORDER BY rp.created_at LIMIT 100`);
  return { held, reports };
}

// approve: publish a held message; remove: hide it for good; dismiss: close reports, leave the message as is.
export async function moderate(db: Db, user: SessionUser, messageId: string, body: RequestBody) {
  if (!user.is_moderator) throw forbidden('Moderators only.');
  onlyKeys(body, ['action']);
  if (!['approve', 'remove', 'dismiss'].includes(body.action)) throw badRequest('Action must be approve, remove or dismiss.');
  requireId(messageId, 'msg', 'message');
  const roomId = await db.tx(async (q) => {
    const msg = await one<Pick<MessageRow, 'id' | 'room_id' | 'sender_id' | 'status' | 'seq'>>(q, 'SELECT id, room_id, sender_id, status, seq FROM messages WHERE id = $1 FOR UPDATE', [messageId]);
    if (!msg) throw notFound('Message not found.');
    if (body.action === 'approve') {
      if (msg.status !== 'held') throw conflict('This message is not waiting for review.');
      const seq = msg.seq ?? await nextSeq(q, msg.room_id);
      await q.query(`UPDATE messages SET status = 'visible', seq = $2 WHERE id = $1`, [messageId, seq]);
      await appendEvent(q, msg.room_id, msg.seq ? 'message_update' : 'message', messageId, msg.seq ? null : seq);
    } else if (body.action === 'remove') {
      await q.query(`UPDATE messages SET status = 'removed' WHERE id = $1`, [messageId]);
      if (msg.seq) await appendEvent(q, msg.room_id, 'message_update', messageId);
    }
    await q.query(`UPDATE reports SET status = $2, resolved_by = $3, resolved_at = now() WHERE message_id = $1 AND status = 'open'`,
      [messageId, body.action === 'remove' ? 'actioned' : 'dismissed', user.id]);
    await recordModeration(q, { roomId: msg.room_id, actorId: user.id, targetUserId: msg.sender_id, messageId, eventType: 'human_review', severity: 'medium', action: body.action });
    return msg.room_id;
  }).catch((err: unknown) => {
    if (err instanceof RoomEndedError) throw new HttpError(410, 'room_ended', 'That watch party has ended.');
    throw err;
  });
  notifyRoom(roomId);
  return { ok: true };
}

export async function resolveAppeal(db: Queryable, user: SessionUser, reportId: string, body: RequestBody) {
  if (!user.is_moderator) throw forbidden('Moderators only.');
  onlyKeys(body, ['action']);
  if (!['uphold', 'overturn'].includes(body.action)) throw badRequest('Action must be uphold or overturn.');
  requireId(reportId, 'rep', 'report');
  const row = await one<Pick<ReportRow, 'moderation_event_id' | 'room_id' | 'reporter_id'>>(db,
    `UPDATE reports SET status = $2, resolved_by = $3, resolved_at = now() WHERE id = $1 AND kind = 'appeal' AND status = 'open' RETURNING moderation_event_id, room_id, reporter_id`,
    [reportId, body.action === 'overturn' ? 'actioned' : 'dismissed', user.id]);
  if (!row) throw notFound('Appeal not found.');
  // An overturned automated decision no longer counts towards the temporary posting pause.
  if (body.action === 'overturn') {
    await db.query(`UPDATE moderation_events SET action_taken = action_taken || '_overturned' WHERE id = $1 AND action_taken NOT LIKE '%_overturned'`, [row.moderation_event_id]);
  }
  await recordModeration(db, { roomId: row.room_id, actorId: user.id, targetUserId: row.reporter_id, eventType: 'appeal_resolved', severity: 'low', action: body.action });
  return { ok: true };
}
