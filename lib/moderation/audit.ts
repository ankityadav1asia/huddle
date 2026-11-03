// Minimal moderation audit trail: ids, categories, policy version and the action taken. Never message text.
import { newId } from '../util.ts';
import { POLICY_VERSION } from './policy.ts';

export async function recordModeration(q, {
  roomId = null, actorId = null, targetUserId = null, messageId = null, eventType, severity,
  categories = [], level = null, action, policyVersion = POLICY_VERSION,
}: {
  roomId?: string | null; actorId?: string | null; targetUserId?: string | null; messageId?: string | null; eventType: string;
  severity: string; categories?: string[]; level?: string | null; action: string; policyVersion?: string;
}) {
  const id = newId('mod');
  await q.query(
    `INSERT INTO moderation_events (id, room_id, actor_id, target_user_id, message_id, event_type, severity, categories, policy_version, level, action_taken)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)`,
    [id, roomId, actorId, targetUserId, messageId, eventType, severity, JSON.stringify(categories), policyVersion, level, action],
  );
  return id;
}

// Repeated rejected or held messages in a short window trigger a temporary posting pause (never a permanent ban).
export async function recentStrikes(q, userId) {
  const row = (await q.query(
    `SELECT count(*)::int AS n, max(created_at) AS last_at FROM moderation_events
      WHERE target_user_id = $1 AND actor_id IS NULL AND action_taken IN ('rejected', 'held')
        AND created_at > now() - interval '10 minutes'`,
    [userId],
  )).rows[0];
  return row;
}
