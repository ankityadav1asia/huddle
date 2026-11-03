// Minimal moderation audit trail: ids, categories, policy version and the action taken. Never message text.
import { newId } from '../util.ts';
import type { Queryable } from '../db/index.ts';
import { POLICY_VERSION } from './policy.ts';

// moderation_events: what was decided about whom, never the text it was about.
export interface ModerationEventRow {
  id: string;
  room_id: string | null;
  actor_id: string | null; // null for automated decisions
  target_user_id: string | null;
  message_id: string | null;
  event_type: string;
  severity: string;
  categories: string[];
  policy_version: string;
  level: string | null;
  action_taken: string;
  created_at: Date;
}

export async function recordModeration(q: Queryable, {
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

// Automated rejections and holds of one user in the last 10 minutes. last_at is null only when n is 0.
export interface Strikes { n: number; last_at: Date }

// Repeated rejected or held messages in a short window trigger a temporary posting pause (never a permanent ban).
export async function recentStrikes(q: Queryable, userId: string): Promise<Strikes> {
  const row = (await q.query(
    `SELECT count(*)::int AS n, max(created_at) AS last_at FROM moderation_events
      WHERE target_user_id = $1 AND actor_id IS NULL AND action_taken IN ('rejected', 'held')
        AND created_at > now() - interval '10 minutes'`,
    [userId],
  )).rows[0];
  return row;
}
