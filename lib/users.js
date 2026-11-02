// Profiles, guest sign-up and people search. Other users only ever see a handle, display name and fan team.
import { many } from './db/index.js';
import { badRequest, conflict, cleanText, onlyKeys, hmac, newId } from './util.js';
import { checkName } from './moderation/classifier.js';
import { requireToken } from './limits.js';
import { createSession, isModerator } from './auth/sessions.js';

const RESERVED = new Set(['huddle', 'admin', 'moderator', 'mod', 'system', 'ai', 'cohost', 'support', 'official']);
const TEAMS = ['MI', 'CSK'];

export function publicMe(user) {
  return { id: user.id, handle: user.handle, display_name: user.display_name, team: user.team, is_moderator: Boolean(user.is_moderator) };
}

// Names and handles are public labels: length, character and safety checks, reserved handles refused.
function validateProfile(body) {
  onlyKeys(body, ['display_name', 'handle', 'team']);
  const name = cleanText(body.display_name, { max: 30, field: 'Display name' });
  if (!checkName(name)) throw badRequest('Choose a different display name.', 'name_rejected');
  const handle = typeof body.handle === 'string' ? body.handle.trim().toLowerCase().replace(/^@/, '') : '';
  if (!/^[a-z0-9_]{3,20}$/.test(handle)) throw badRequest('Handles use 3-20 letters, numbers or underscores.', 'invalid_handle');
  if (RESERVED.has(handle) || !checkName(handle.replace(/_/g, ' '))) throw badRequest('That handle is not available.', 'handle_taken');
  const team = body.team == null || body.team === '' ? null : body.team;
  if (team !== null && !TEAMS.includes(team)) throw badRequest('Pick MI, CSK or no team.');
  return { name, handle, team };
}

const handleTaken = (err) => err?.code === '23505' || /unique/i.test(err?.message || '');

// Joining without a phone or password: a guest profile plus a session cookie. Limited per network so nobody
// can mint accounts to get around the one-message-every-30-seconds rule.
export async function createGuest(db, cfg, body, ip) {
  const { name, handle, team } = validateProfile(body);
  await requireToken(db, `guest_ip:${hmac(`ip:${ip}`)}`, { limit: cfg.guest.perIpPerHour, windowSeconds: 3600 },
    'Too many new profiles from this network. Try again later.');
  try {
    return await db.tx(async (q) => {
      const user = (await q.query(
        `INSERT INTO users (id, handle, display_name, team, last_login_at) VALUES ($1, $2, $3, $4, now())
         RETURNING id, handle, display_name, team`,
        [newId('usr'), handle, name, team])).rows[0];
      await q.query('INSERT INTO notification_prefs (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [user.id]);
      const session = await createSession(q, user.id);
      return { user: { ...user, is_moderator: isModerator(user) }, session };
    });
  } catch (err) {
    if (handleTaken(err)) throw conflict('That handle is taken. Try another one.', 'handle_taken');
    throw err;
  }
}

export async function updateProfile(db, user, body) {
  const { name, handle, team } = validateProfile(body);
  try {
    const rows = await many(db,
      'UPDATE users SET handle = $2, display_name = $3, team = $4 WHERE id = $1 RETURNING id, handle, display_name, team',
      [user.id, handle, name, team]);
    return publicMe({ ...rows[0], is_moderator: user.is_moderator });
  } catch (err) {
    if (handleTaken(err)) throw conflict('That handle is taken.', 'handle_taken');
    throw err;
  }
}

// Search users by handle or display name (prefix match).
export async function searchUsers(db, user, query) {
  const q = String(query.q || '').trim().toLowerCase().replace(/^@/, '');
  if (q.length < 2 || q.length > 30) return { users: [] };
  await requireToken(db, `search:${user.id}`, { limit: 30, windowSeconds: 60 }, 'Slow down a little.');
  const like = `${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const users = await many(db,
    `SELECT id, handle, display_name AS name, team FROM users
      WHERE id <> $1 AND handle IS NOT NULL AND (handle LIKE $2 OR lower(display_name) LIKE $2)
      ORDER BY handle LIMIT 10`,
    [user.id, like]);
  return { users };
}
