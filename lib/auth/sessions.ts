// Cookie sessions. The browser holds a random token in an HttpOnly cookie; the database keeps only its hash.
import type { IncomingMessage } from 'node:http';
import { config } from '../config.ts';
import { newId, newToken, sha256 } from '../util.ts';
import type { Queryable } from '../db/index.ts';
import type { Sports } from '../db/rows.ts';

// Over HTTPS the cookie uses the __Host- prefix: Secure, host-only, path "/", so no other subdomain can set it.
const PLAIN = 'huddle_session';
const HOST = '__Host-huddle_session';
const cookieName = () => (config().cookieSecure ? HOST : PLAIN);

function readCookie(req: IncomingMessage, name: string) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

export async function createSession(q: Queryable, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken();
  const { rows } = await q.query(
    `INSERT INTO sessions (id, token_hash, user_id, expires_at) VALUES ($1, $2, $3, now() + make_interval(days => $4))
     RETURNING expires_at`,
    [newId('ses'), sha256(token), userId, config().sessionDays],
  );
  return { token, expiresAt: rows[0].expires_at };
}

export function sessionCookie(token: string, expiresAt: Date | string | number) {
  const secure = config().cookieSecure ? '; Secure' : '';
  return `${cookieName()}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}${secure}`;
}

export function clearSessionCookie() {
  const secure = config().cookieSecure ? '; Secure' : '';
  return `${cookieName()}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

// Platform moderators are listed by account id (MODERATOR_USER_IDS): ids are random and server-generated, so
// nobody can claim moderator rights by picking a name or handle.
export function isModerator(user: { id: string }) {
  return config().moderatorUserIds.includes(user.id);
}

// The signed-in person every route sees as `user`.
export interface SessionUser {
  id: string;
  handle: string | null;
  sports: Sports;
  is_moderator: boolean;
}

export interface Session { id: string }

interface SessionAuth { user: SessionUser; session: Session }

// sessions joined with users, as sessionUser reads them.
interface SessionLookupRow {
  session_id: string;
  last_used_at: Date;
  id: string;
  handle: string | null;
  sports: Sports | null;
}

// Resolves the signed-in user from the cookie, or null. Never trusts any user id sent by the client.
export async function sessionUser(db: Queryable, req: IncomingMessage): Promise<SessionAuth | null> {
  const token = readCookie(req, cookieName());
  if (!token || token.length > 100) return null;
  const { rows } = await db.query(
    `SELECT s.id AS session_id, s.last_used_at, u.id, u.handle, u.sports
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sha256(token)],
  );
  const row: SessionLookupRow | undefined = rows[0];
  if (!row) return null;
  if (Date.now() - new Date(row.last_used_at).getTime() > 5 * 60 * 1000) {
    await db.query('UPDATE sessions SET last_used_at = now() WHERE id = $1', [row.session_id]);
  }
  const user: SessionUser = { id: row.id, handle: row.handle, sports: row.sports || {}, is_moderator: false };
  user.is_moderator = isModerator(user);
  return { user, session: { id: row.session_id } };
}

export async function revokeSession(q: Queryable, sessionId: string) {
  await q.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [sessionId]);
}

// "Sign out on all devices": every session of this user stops working on its next request.
export async function revokeAllSessions(q: Queryable, userId: string) {
  await q.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
}
