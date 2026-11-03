// Housekeeping, idempotent and safe to run often: expires stale invitations, enforces retention windows for
// operational metadata, and makes sure every ended room past its retention window gets purged.
import { config } from '../config.ts';
import { many } from '../db/index.ts';
import { enqueue } from './queue.ts';

export async function sweep(db) {
  const r = config().retention;
  await db.query(`UPDATE room_invitations SET status = 'expired' WHERE status = 'pending' AND expires_at <= now()`);
  await db.query(`DELETE FROM rate_events WHERE created_at < now() - interval '2 hours'`);
  await db.query(`DELETE FROM sessions WHERE expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days'`);
  await db.query(`DELETE FROM notification_deliveries WHERE created_at < now() - make_interval(hours => $1)`, [r.deliveryHours]);
  await db.query(`DELETE FROM ai_calls WHERE created_at < now() - make_interval(days => $1)`, [r.aiLogDays]);
  await db.query(`DELETE FROM moderation_events WHERE created_at < now() - make_interval(days => $1)`, [r.moderationDays]);
  await db.query(`DELETE FROM jobs WHERE status IN ('done', 'cancelled') AND updated_at < now() - interval '1 day'`);
  await db.query(`DELETE FROM user_send_cooldowns WHERE next_allowed_at < now() - interval '1 hour'`);
  // Retention backstop: an ended room whose purge time has passed is purged even if its job was lost.
  const due = await many(db, `SELECT id FROM rooms WHERE status = 'ended' AND purge_after <= now() LIMIT 20`);
  for (const room of due) {
    await enqueue(db, { type: 'room_purge', dedupeKey: `purge:${room.id}`, payload: { room_id: room.id }, priority: 8, maxAttempts: 5, reschedule: true });
  }
}
