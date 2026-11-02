// Phone OTP sign-in. Responses never reveal whether a number already has an account.
// Codes expire, are single-use, have an attempt limit, and are never stored or logged in plaintext.
import { HttpError, badRequest, hmac, newId } from '../util.js';
import { normalizeIndianMobile } from './phone.js';
import { otpProvider } from './otp-providers.js';
import { createSession } from './sessions.js';
import { requireToken } from '../limits.js';

const tooMany = (retryAfter, message) => new HttpError(429, 'rate_limited', message, { retry_after: retryAfter });

export async function requestOtp(db, cfg, { phone, ip }) {
  otpProvider(cfg); // refuses demo in production before anything else happens
  const e164 = normalizeIndianMobile(phone);
  if (!e164) throw badRequest('Enter a valid 10-digit Indian mobile number.', 'invalid_phone');
  const phoneHash = hmac(`phone:${e164}`);
  const ipHash = hmac(`ip:${ip}`);
  const o = cfg.otp;

  const { rows } = await db.query(
    `SELECT
       (SELECT max(created_at) FROM otp_challenges WHERE phone_hash = $1) AS last_at,
       (SELECT count(*)::int FROM otp_challenges WHERE phone_hash = $1 AND created_at > now() - interval '1 hour') AS per_number,
       (SELECT count(*)::int FROM otp_challenges WHERE ip_hash = $2 AND created_at > now() - interval '1 hour') AS per_ip,
       (SELECT count(*)::int FROM otp_challenges WHERE created_at > now() - interval '1 hour') AS global`,
    [phoneHash, ipHash],
  );
  const stats = rows[0];
  // Cost guard against SMS pumping: a hard cap on codes sent per hour across the whole server.
  if (stats.global >= o.globalPerHour) throw new HttpError(503, 'otp_busy', 'Sign-in is busy right now. Try again in a few minutes.');
  if (stats.last_at) {
    const wait = Math.ceil((new Date(stats.last_at).getTime() + o.resendSeconds * 1000 - Date.now()) / 1000);
    if (wait > 0) throw tooMany(wait, `Wait ${wait}s before asking for another code.`);
  }
  if (stats.per_number >= o.perNumberPerHour || stats.per_ip >= o.perIpPerHour) {
    throw tooMany(600, 'Too many codes requested. Try again later.');
  }

  const provider = otpProvider(cfg);
  const id = newId('otp');
  const started = await provider.start(e164, id);
  await db.query(
    `INSERT INTO otp_challenges (id, phone_hash, code_hash, provider, ip_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))`,
    [id, phoneHash, started.codeHash || null, provider.name, ipHash, o.ttlSeconds],
  );
  return {
    sent: true,
    resend_after: o.resendSeconds,
    expires_in: o.ttlSeconds,
    provider: provider.name,
    // Demo provider only: no SMS exists, so the code is shown on screen and labelled as demo.
    ...(started.demoCode ? { demo_code: started.demoCode } : {}),
  };
}

export async function verifyOtp(db, cfg, { phone, code, ip = 'local' }) {
  const e164 = normalizeIndianMobile(phone);
  if (!e164) throw badRequest('Enter a valid 10-digit Indian mobile number.', 'invalid_phone');
  if (typeof code !== 'string' || !/^\d{4,8}$/.test(code)) throw badRequest('Enter the code from the SMS.', 'invalid_code');
  otpProvider(cfg); // refuses demo in production before anything else happens
  const phoneHash = hmac(`phone:${e164}`);
  // Brute-force limits beyond the per-code attempt cap: per IP across numbers, and per number across codes.
  await requireToken(db, `otp_verify_ip:${hmac(`ip:${ip}`)}`, { limit: cfg.otp.verifyPerIpPerHour, windowSeconds: 3600 }, 'Too many sign-in attempts from this network. Try again later.');
  const failed = (await db.query(
    `SELECT COALESCE(sum(attempts), 0)::int AS n FROM otp_challenges WHERE phone_hash = $1 AND created_at > now() - interval '1 hour'`,
    [phoneHash])).rows[0].n;
  if (failed >= cfg.otp.failedPerNumberPerHour) throw tooMany(3600, 'Too many wrong codes for this number. Try again in an hour.');

  const challenge = (await db.query(
    `SELECT * FROM otp_challenges WHERE phone_hash = $1 AND consumed_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`,
    [phoneHash],
  )).rows[0];
  if (!challenge) throw badRequest('That code has expired. Request a new one.', 'otp_expired');

  // Count the attempt before checking, atomically, so parallel guesses cannot exceed the limit.
  const claimed = (await db.query(
    `UPDATE otp_challenges SET attempts = attempts + 1
      WHERE id = $1 AND consumed_at IS NULL AND attempts < $2 RETURNING attempts`,
    [challenge.id, cfg.otp.maxAttempts],
  )).rows[0];
  if (!claimed) throw tooMany(cfg.otp.resendSeconds, 'Too many wrong codes. Request a new one.');

  const provider = otpProvider(cfg);
  const ok = await provider.check(e164, code, challenge);
  if (!ok) {
    throw new HttpError(400, 'wrong_code', 'That code is not right.', { attempts_left: Math.max(0, cfg.otp.maxAttempts - claimed.attempts) });
  }
  const consumed = (await db.query(
    'UPDATE otp_challenges SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL RETURNING id',
    [challenge.id],
  )).rows[0];
  if (!consumed) throw badRequest('That code was already used. Request a new one.', 'otp_used');

  return completeSignIn(db, e164);
}

// Shared by every sign-in method once the phone number is proven: find or create the user, open a session.
export function completeSignIn(db, e164, { firebaseUid = null } = {}) {
  return db.tx(async (q) => {
    // A Firebase user who changed their number keeps one uid: detach it from the old number first.
    if (firebaseUid) await q.query('UPDATE users SET firebase_uid = NULL WHERE firebase_uid = $1 AND phone_e164 <> $2', [firebaseUid, e164]);
    const user = (await q.query(
      `INSERT INTO users (id, phone_e164, firebase_uid, last_login_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (phone_e164) DO UPDATE SET last_login_at = now(), firebase_uid = COALESCE(EXCLUDED.firebase_uid, users.firebase_uid)
       RETURNING id, handle, display_name, team, phone_e164`,
      [newId('usr'), e164, firebaseUid],
    )).rows[0];
    await q.query('INSERT INTO notification_prefs (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [user.id]);
    const session = await createSession(q, user.id);
    return { user, session };
  });
}
