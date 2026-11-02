// Profiles, guest sign-up and people search. Other users only ever see a handle, display name, fan team and the
// players a fan picked.
import { many } from './db/index.js';
import { badRequest, conflict, cleanText, onlyKeys, hmac, newId } from './util.js';
import { checkName } from './moderation/classifier.js';
import { requireToken } from './limits.js';
import { createSession, isModerator } from './auth/sessions.js';
import { SQUADS } from './match/demo-script.js';

const RESERVED = new Set(['huddle', 'admin', 'moderator', 'mod', 'system', 'ai', 'cohost', 'support', 'official']);
const TEAMS = ['MI', 'CSK'];
const PLAYERS = new Set(Object.values(SQUADS).flat());
export const MAX_PICKS = 3;

export function publicMe(user) {
  return {
    id: user.id, handle: user.handle, display_name: user.display_name, team: user.team, picks: user.picks || [],
    is_moderator: Boolean(user.is_moderator),
  };
}

// Players a fan picked: up to three different names from the demo squads. Undefined (not sent) keeps the old ones.
function validatePicks(picks) {
  if (picks === undefined) return undefined;
  if (picks === null) return [];
  if (!Array.isArray(picks) || picks.length > MAX_PICKS || new Set(picks).size !== picks.length || !picks.every((p) => PLAYERS.has(p))) {
    throw badRequest(`Pick up to ${MAX_PICKS} different players from the squads.`, 'invalid_picks');
  }
  return picks;
}

// Names and handles are public labels: length, character and safety checks, reserved handles refused.
function validateProfile(body) {
  onlyKeys(body, ['display_name', 'handle', 'team', 'picks']);
  const name = cleanText(body.display_name, { max: 30, field: 'Display name' });
  if (!checkName(name)) throw badRequest('Choose a different display name.', 'name_rejected');
  const handle = typeof body.handle === 'string' ? body.handle.trim().toLowerCase().replace(/^@/, '') : '';
  if (!/^[a-z0-9_]{3,20}$/.test(handle)) throw badRequest('Handles use 3-20 letters, numbers or underscores.', 'invalid_handle');
  // demo_ handles belong to the seeded demo friends, so a real person can never be mistaken for one.
  if (RESERVED.has(handle) || handle.startsWith('demo_') || !checkName(handle.replace(/_/g, ' '))) throw badRequest('That handle is not available.', 'handle_taken');
  const team = body.team == null || body.team === '' ? null : body.team;
  if (team !== null && !TEAMS.includes(team)) throw badRequest('Pick MI, CSK or no team.');
  return { name, handle, team, picks: validatePicks(body.picks) };
}

const handleTaken = (err) => err?.code === '23505' || /unique/i.test(err?.message || '');

// Joining without a phone or password: a guest profile plus a session cookie. Limited per network so nobody
// can mint accounts to get around the one-message-every-30-seconds rule.
export async function createGuest(db, cfg, body, ip) {
  const { name, handle, team, picks } = validateProfile(body);
  await requireToken(db, `guest_ip:${hmac(`ip:${ip}`)}`, { limit: cfg.guest.perIpPerHour, windowSeconds: 3600 },
    'Too many new profiles from this network. Try again later.');
  try {
    return await db.tx(async (q) => {
      const user = (await q.query(
        `INSERT INTO users (id, handle, display_name, team, picks, last_login_at) VALUES ($1, $2, $3, $4, $5::text[], now())
         RETURNING id, handle, display_name, team, picks`,
        [newId('usr'), handle, name, team, picks ?? []])).rows[0];
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
  const { name, handle, team, picks } = validateProfile(body);
  try {
    const rows = await many(db,
      `UPDATE users SET handle = $2, display_name = $3, team = $4, picks = COALESCE($5::text[], picks) WHERE id = $1
       RETURNING id, handle, display_name, team, picks`,
      [user.id, handle, name, team, picks ?? null]);
    return publicMe({ ...rows[0], is_moderator: user.is_moderator });
  } catch (err) {
    if (handleTaken(err)) throw conflict('That handle is taken.', 'handle_taken');
    throw err;
  }
}

// Search users by handle or display name (prefix match). Demo friends are marked so the UI can label them,
// and left out entirely when they are switched off (DEMO_USERS=false).
export async function searchUsers(db, user, query, { includeDemo = true } = {}) {
  const q = String(query.q || '').trim().toLowerCase().replace(/^@/, '');
  if (q.length < 2 || q.length > 30) return { users: [] };
  await requireToken(db, `search:${user.id}`, { limit: 30, windowSeconds: 60 }, 'Slow down a little.');
  const like = `${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const users = await many(db,
    `SELECT id, handle, display_name AS name, team, is_demo AS demo FROM users
      WHERE id <> $1 AND handle IS NOT NULL AND (handle LIKE $2 OR lower(display_name) LIKE $2) AND ($3::boolean OR NOT is_demo)
      ORDER BY is_demo, handle LIMIT 10`,
    [user.id, like, includeDemo]);
  return { users };
}

// ---------------------------------------------------------------- demo friends
// Seeded, clearly labelled profiles ("(demo)" in the name, demo_ handles, is_demo) that exist only so a presenter
// can show the invitation flow alone. They have no sessions, so nobody can sign in as them.
export const DEMO_FRIENDS = [
  { handle: 'demo_aarav', name: 'Aarav (demo)', team: 'CSK' },
  { handle: 'demo_diya', name: 'Diya (demo)', team: 'MI' },
  { handle: 'demo_kabir', name: 'Kabir (demo)', team: 'CSK' },
  { handle: 'demo_meera', name: 'Meera (demo)', team: 'MI' },
  { handle: 'demo_rohan', name: 'Rohan (demo)', team: null },
  { handle: 'demo_sana', name: 'Sana (demo)', team: 'MI' },
];

let demoFriendsReady = false;

// Idempotent: safe on every start and on every instance; a handle someone already owns is simply skipped.
export async function ensureDemoFriends(db) {
  if (demoFriendsReady) return;
  for (const f of DEMO_FRIENDS) {
    await db.query(
      `INSERT INTO users (id, handle, display_name, team, is_demo) VALUES ($1, $2, $3, $4, true)
       ON CONFLICT DO NOTHING`,
      [newId('usr'), f.handle, f.name, f.team]);
  }
  demoFriendsReady = true;
}

export function resetDemoFriendsFlag() {
  demoFriendsReady = false;
}

export async function demoFriends(db, user) {
  const users = await many(db,
    `SELECT id, handle, display_name AS name, team, true AS demo FROM users WHERE is_demo AND id <> $1 ORDER BY handle LIMIT 10`,
    [user.id]);
  return { users };
}
