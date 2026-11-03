// One durable job queue in the existing database (no Redis, no broker). Jobs carry ids and deadlines only.
// Workers claim with FOR UPDATE SKIP LOCKED, retry with exponential backoff and jitter, and park exhausted
// jobs as 'dead' (the dead-letter state). Every handler is idempotent because a job can run more than once.
import { newId } from '../util.ts';
import type { Queryable } from '../db/index.ts';
import type { JobRow } from '../db/rows.ts';

// A job as claimJobs hands it out: the row, plus how long it had been due (seconds).
export interface ClaimedJob extends JobRow { queue_age_s: number }

// The tags a failure may carry: our errors set category and retryable, drivers set code. Anything can be thrown
// (tests fail jobs with plain objects), so a tag may be missing or of any type.
interface FailureTags { category?: unknown; code?: unknown; retryable?: unknown }
export const failureTags = (err: unknown): FailureTags => (typeof err === 'object' && err !== null ? err : {});

export async function enqueue(q: Queryable, {
  type, roomId = null, dedupeKey = null, payload = {}, delaySeconds = 0, priority = 5,
  maxAttempts = 3, expiresInSeconds = null, reschedule = false,
}: {
  type: string; roomId?: string | null; dedupeKey?: string | null; payload?: object; delaySeconds?: number; priority?: number;
  maxAttempts?: number; expiresInSeconds?: number | null; reschedule?: boolean;
}): Promise<string | null> {
  const onConflict = reschedule
    ? `DO UPDATE SET run_at = EXCLUDED.run_at, status = 'queued', attempts = 0, payload = EXCLUDED.payload,
         expires_at = EXCLUDED.expires_at, locked_until = NULL, finished_at = NULL, last_error = NULL, updated_at = now()
       WHERE jobs.status <> 'running'`
    : 'DO NOTHING';
  const { rows } = await q.query(
    `INSERT INTO jobs (id, type, room_id, dedupe_key, payload, priority, status, run_at, expires_at, max_attempts)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'queued', now() + $7::float8 * interval '1 second',
             CASE WHEN $8::float8 IS NULL THEN NULL ELSE now() + $8::float8 * interval '1 second' END, $9)
     ON CONFLICT (dedupe_key) ${onConflict}
     RETURNING id`,
    [newId('job'), type, roomId, dedupeKey, JSON.stringify(payload), priority, delaySeconds, expiresInSeconds, maxAttempts],
  );
  return rows[0]?.id || null;
}

export async function claimJobs(db: Queryable, { limit = 5, lockSeconds = 60 } = {}): Promise<ClaimedJob[]> {
  const { rows } = await db.query(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = now(),
            locked_until = now() + $2::float8 * interval '1 second'
      WHERE id IN (
        SELECT id FROM jobs
         WHERE (status = 'queued' AND run_at <= now()) OR (status = 'running' AND locked_until < now())
         ORDER BY priority, run_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED)
      RETURNING *, EXTRACT(EPOCH FROM (now() - run_at))::float8 AS queue_age_s`,
    [limit, lockSeconds],
  );
  return rows;
}

export async function completeJob(db: Queryable, job: Pick<JobRow, 'id'>) {
  await db.query(
    `UPDATE jobs SET status = 'done', finished_at = now(), locked_until = NULL, updated_at = now() WHERE id = $1 AND status = 'running'`,
    [job.id],
  );
}

export async function cancelJob(db: Queryable, job: Pick<JobRow, 'id'>, reason: string) {
  await db.query(
    `UPDATE jobs SET status = 'cancelled', finished_at = now(), locked_until = NULL, last_error = $2, updated_at = now() WHERE id = $1`,
    [job.id, reason],
  );
}

// Retries transient failures with exponential backoff + jitter; exhausted or permanent failures go to 'dead'.
export async function failJob(db: Queryable, job: Pick<JobRow, 'id' | 'attempts' | 'max_attempts'>, err: unknown, { random = Math.random } = {}): Promise<'retry' | 'dead'> {
  const tags = failureTags(err);
  const category = String(tags.category || tags.code || 'error').slice(0, 60);
  const retryable = tags.retryable !== false;
  if (retryable && job.attempts < job.max_attempts) {
    const delay = Math.min(60, 2 ** job.attempts) * (0.5 + random());
    await db.query(
      `UPDATE jobs SET status = 'queued', run_at = now() + $2::float8 * interval '1 second', locked_until = NULL,
              last_error = $3, updated_at = now() WHERE id = $1 AND status = 'running'`,
      [job.id, delay, category],
    );
    return 'retry';
  }
  await db.query(
    `UPDATE jobs SET status = 'dead', finished_at = now(), locked_until = NULL, last_error = $2, updated_at = now() WHERE id = $1`,
    [job.id, category],
  );
  return 'dead';
}

// Room closure invalidates every queued or running job for that room.
export async function cancelRoomJobs(q: Queryable, roomId: string) {
  await q.query(
    `UPDATE jobs SET status = 'cancelled', finished_at = now(), locked_until = NULL, last_error = 'room_ended', updated_at = now()
      WHERE room_id = $1 AND status IN ('queued', 'running')`,
    [roomId],
  );
}

// Per job status: how many, and how long the oldest due job has waited (seconds; 0 if none is due).
interface QueueStat { status: JobRow['status']; n: number; oldest_due_s: number }

export async function queueStats(db: Queryable): Promise<QueueStat[]> {
  const { rows } = await db.query(
    `SELECT status, count(*)::int AS n,
            COALESCE(max(EXTRACT(EPOCH FROM (now() - run_at))) FILTER (WHERE status = 'queued' AND run_at <= now()), 0)::float8 AS oldest_due_s
       FROM jobs GROUP BY status`,
  );
  return rows;
}
