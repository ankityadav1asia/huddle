// Cookie sessions. The browser holds a random token in an HttpOnly cookie; the database keeps only its hash.
import { config } from '../config.js';
import { newId, newToken, sha256 } from '../util.js';

// Over HTTPS the cookie uses the __Host- prefix: Secure, host-only, path "/", so no other subdomain can set it.
const PLAIN = 'huddle_session';
const HOST = '__Host-huddle_session';
export const cookieName = () => (config().cookieSecure ? HOST : PLAIN);
export const COOKIE = PLAIN;

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

export async function createSession(q, userId) {
  const token = newToken();
  const days = config().sessionDays;
  const { rows } = await q.query(
    `INSERT INTO sessions (id, token_hash, user_id, expires_at) VALUES ($1, $2, $3, now() + make_interval(days => $4))
     RETURNING expires_at`,
    [newId('ses'), sha256(token), userId, days],
  );
  return { token, expiresAt: rows[0].expires_at };
}

export function sessionCookie(token, expiresAt) {
  const secure = config().cookieSecure ? '; Secure' : '';
  return `${cookieName()}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}${secure}`;
}

export function clearSessionCookie() {
  const secure = config().cookieSecure ? '; Secure' : '';
  return `${cookieName()}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export function isModerator(user) {
  return config().moderatorPhones.includes(user.phone_e164);
}

// Resolves the signed-in user from the cookie, or null. Never trusts any user id sent by the client.
export async function sessionUser(db, req) {
  const token = readCookie(req, cookieName());
  if (!token || token.length > 100) return null;
  const { rows } = await db.query(
    `SELECT s.id AS session_id, s.last_used_at, u.id, u.phone_e164, u.handle, u.display_name, u.team
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sha256(token)],
  );
  const row = rows[0];
  if (!row) return null;
  if (Date.now() - new Date(row.last_used_at).getTime() > 5 * 60 * 1000) {
    await db.query('UPDATE sessions SET last_used_at = now() WHERE id = $1', [row.session_id]);
  }
  const user = { id: row.id, phone_e164: row.phone_e164, handle: row.handle, display_name: row.display_name, team: row.team };
  user.is_moderator = isModerator(user);
  return { user, session: { id: row.session_id } };
}

export async function revokeSession(q, sessionId) {
  await q.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [sessionId]);
}

// "Sign out on all devices": every session of this user stops working on its next request.
export async function revokeAllSessions(q, userId) {
  await q.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
}
