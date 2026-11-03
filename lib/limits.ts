// Sliding-window limits for secondary actions (OTP requests, AI requests, reactions, user search).
// An advisory transaction lock per bucket makes count-then-insert atomic across concurrent requests.
// The chat rule (one message per user every 10 s) has its own atomic limiter in chat/messages.js.
import { HttpError } from './util.ts';

export async function takeToken(db, bucket, { limit, windowSeconds }) {
  return db.tx(async (q) => {
    await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [bucket]);
    const { rows } = await q.query(
      `SELECT count(*)::int AS n, min(created_at) AS oldest FROM rate_events
        WHERE bucket = $1 AND created_at > now() - make_interval(secs => $2)`,
      [bucket, windowSeconds],
    );
    const { n, oldest } = rows[0];
    if (n >= limit) {
      const retryAfter = Math.max(1, Math.ceil((new Date(oldest).getTime() + windowSeconds * 1000 - Date.now()) / 1000));
      return { ok: false, retryAfter };
    }
    await q.query('INSERT INTO rate_events (bucket) VALUES ($1)', [bucket]);
    return { ok: true };
  });
}

export async function requireToken(db, bucket, opts, message = 'Too many requests. Try again shortly.') {
  const r = await takeToken(db, bucket, opts);
  if (!r.ok) throw new HttpError(429, 'rate_limited', message, { retry_after: r.retryAfter });
}
