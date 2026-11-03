// Sliding-window limits for secondary actions (guest sign-ups, AI requests, reactions, user search).
// An advisory transaction lock per bucket makes count-then-insert atomic across concurrent requests.
// The chat cooldown has its own atomic limiter in chat/messages.ts.
import { HttpError } from './util.ts';
import type { Db } from './db/index.ts';

interface TokenWindow { limit: number; windowSeconds: number }
type TokenResult = { ok: true } | { ok: false; retryAfter: number };

export async function takeToken(db: Db, bucket: string, { limit, windowSeconds }: TokenWindow): Promise<TokenResult> {
  return db.tx(async (q): Promise<TokenResult> => {
    await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [bucket]);
    const { rows } = await q.query(
      `SELECT count(*)::int AS n, min(created_at) AS oldest FROM rate_events
        WHERE bucket = $1 AND created_at > now() - make_interval(secs => $2)`,
      [bucket, windowSeconds],
    );
    const { n, oldest }: { n: number; oldest: Date | null } = rows[0];
    if (n >= limit) {
      // At least one event is in the window here (limits are positive), so oldest is set.
      const retryAfter = Math.max(1, Math.ceil((new Date(oldest!).getTime() + windowSeconds * 1000 - Date.now()) / 1000));
      return { ok: false, retryAfter };
    }
    await q.query('INSERT INTO rate_events (bucket) VALUES ($1)', [bucket]);
    return { ok: true };
  });
}

export async function requireToken(db: Db, bucket: string, opts: TokenWindow, message = 'Too many requests. Try again shortly.') {
  const r = await takeToken(db, bucket, opts);
  if (!r.ok) throw new HttpError(429, 'rate_limited', message, { retry_after: r.retryAfter });
}
