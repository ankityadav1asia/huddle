// Profiles, guest sign-up and people search. Other users only ever see a handle, display name, the team a fan
// backs in each sport and the players they picked.
import { one, many } from './db/index.js';
import { badRequest, conflict, cleanText, onlyKeys, hmac, newId } from './util.js';
import { checkName } from './moderation/classifier.js';
import { requireToken } from './limits.js';
import { createSession, isModerator } from './auth/sessions.js';
import { SPORTS } from './match/fixture.js';

const RESERVED = new Set(['huddle', 'admin', 'moderator', 'mod', 'system', 'ai', 'cohost', 'support', 'official']);
export const MAX_PICKS = 3;

export function publicMe(user) {
  return {
    id: user.id, handle: user.handle, display_name: user.display_name, sports: user.sports || {},
    is_moderator: Boolean(user.is_moderator),
  };
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sportOf = (sport) => (Object.hasOwn(SPORTS, sport) ? SPORTS[sport] : null);

// A fan's choice in one sport: one of its teams (or none) and up to three different players from it. Picks left
// out keep the ones chosen before.
function validateChoice(sport, choice, before) {
  const s = sportOf(sport);
  if (!s) throw badRequest('Pick a sport Huddle has a watch party for.', 'invalid_sport');
  if (!isObject(choice)) throw badRequest(`Send a team and players for ${s.label}.`, 'invalid_sports');
  onlyKeys(choice, ['team', 'picks']);
  const team = choice.team == null || choice.team === '' ? null : choice.team;
  if (team !== null && !s.teams.some((t) => t.code === team)) {
    throw badRequest(`Pick ${s.teams.map((t) => t.name).join(', ')} or no team.`, 'invalid_team');
  }
  const picks = choice.picks === undefined ? before?.picks || [] : choice.picks ?? [];
  if (!Array.isArray(picks) || picks.length > MAX_PICKS || new Set(picks).size !== picks.length
    || !picks.every((p) => s.players.some((x) => x.name === p))) {
    throw badRequest(`Pick up to ${MAX_PICKS} different ${s.label} players.`, 'invalid_picks');
  }
  return { team, picks };
}

// Each sport sent replaces that sport's choice, null forgets it (the room asks again), and sports left out stay.
export function mergeSports(before, sports) {
  if (sports === undefined) return before;
  if (!isObject(sports)) throw badRequest('Send your teams as an object keyed by sport.', 'invalid_sports');
  const next = { ...before };
  for (const [sport, choice] of Object.entries(sports)) {
    if (!sportOf(sport)) throw badRequest('Pick a sport Huddle has a watch party for.', 'invalid_sport');
    if (choice === null) delete next[sport];
    else next[sport] = validateChoice(sport, choice, before[sport]);
  }
  return next;
}

// Names and handles are public labels: length, character and safety checks, reserved handles refused.
function validateProfile(body) {
  onlyKeys(body, ['display_name', 'handle', 'sports']);
  const name = cleanText(body.display_name, { max: 30, field: 'Display name' });
  if (!checkName(name)) throw badRequest('Choose a different display name.', 'name_rejected');
  const handle = typeof body.handle === 'string' ? body.handle.trim().toLowerCase().replace(/^@/, '') : '';
  if (!/^[a-z0-9_]{3,20}$/.test(handle)) throw badRequest('Handles use 3-20 letters, numbers or underscores.', 'invalid_handle');
  // demo_ handles belong to the seeded demo friends, so a real person can never be mistaken for one.
  if (RESERVED.has(handle) || handle.startsWith('demo_') || !checkName(handle.replace(/_/g, ' '))) throw badRequest('That handle is not available.', 'handle_taken');
  return { name, handle };
}

const handleTaken = (err) => err?.code === '23505' || /unique/i.test(err?.message || '');

// Joining without a phone or password: a guest profile plus a session cookie. Limited per network so nobody
// can mint accounts to get around the one-message-every-10-seconds rule.
export async function createGuest(db, cfg, body, ip) {
  const { name, handle } = validateProfile(body);
  const sports = mergeSports({}, body.sports);
  await requireToken(db, `guest_ip:${hmac(`ip:${ip}`)}`, { limit: cfg.guest.perIpPerHour, windowSeconds: 3600 },
    'Too many new profiles from this network. Try again later.');
  try {
    return await db.tx(async (q) => {
      const user = (await q.query(
        `INSERT INTO users (id, handle, display_name, sports, last_login_at) VALUES ($1, $2, $3, $4::jsonb, now())
         RETURNING id, handle, display_name, sports`,
        [newId('usr'), handle, name, JSON.stringify(sports)])).rows[0];
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
  const { name, handle } = validateProfile(body);
  try {
    return await db.tx(async (q) => {
      const before = (await one(q, 'SELECT sports FROM users WHERE id = $1 FOR UPDATE', [user.id])).sports;
      const row = await one(q,
        `UPDATE users SET handle = $2, display_name = $3, sports = $4::jsonb WHERE id = $1
         RETURNING id, handle, display_name, sports`,
        [user.id, handle, name, JSON.stringify(mergeSports(before, body.sports))]);
      return publicMe({ ...row, is_moderator: user.is_moderator });
    });
  } catch (err) {
    if (handleTaken(err)) throw conflict('That handle is taken.', 'handle_taken');
    throw err;
  }
}

// One sport's choice on its own: what a room asks when you first watch that sport ("Who are you backing?").
export async function setSportChoice(db, user, sport, body) {
  return db.tx(async (q) => {
    const before = (await one(q, 'SELECT sports FROM users WHERE id = $1 FOR UPDATE', [user.id])).sports;
    const row = await one(q, 'UPDATE users SET sports = $2::jsonb WHERE id = $1 RETURNING id, handle, display_name, sports',
      [user.id, JSON.stringify(mergeSports(before, { [sport]: body }))]);
    return publicMe({ ...row, is_moderator: user.is_moderator });
  });
}

// The teams someone backs, one code per sport they chose a team in, in home-screen order.
export const teamsOf = (sports) => Object.keys(SPORTS).map((s) => sports?.[s]?.team).filter(Boolean);

// Search users by handle or display name (prefix match). Demo friends are marked so the UI can label them,
// and left out entirely when they are switched off (DEMO_USERS=false).
export async function searchUsers(db, user, query, { includeDemo = true } = {}) {
  const q = String(query.q || '').trim().toLowerCase().replace(/^@/, '');
  if (q.length < 2 || q.length > 30) return { users: [] };
  await requireToken(db, `search:${user.id}`, { limit: 30, windowSeconds: 60 }, 'Slow down a little.');
  const like = `${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const rows = await many(db,
    `SELECT id, handle, display_name AS name, sports, is_demo AS demo FROM users
      WHERE id <> $1 AND handle IS NOT NULL AND (handle LIKE $2 OR lower(display_name) LIKE $2) AND ($3::boolean OR NOT is_demo)
      ORDER BY is_demo, handle LIMIT 10`,
    [user.id, like, includeDemo]);
  return { users: rows.map(({ sports, ...u }) => ({ ...u, teams: teamsOf(sports) })) };
}

// ---------------------------------------------------------------- demo friends
// Seeded, clearly labelled profiles ("(demo)" in the name, demo_ handles, is_demo) that exist only so a presenter
// can show the invitation flow alone. They have no sessions, so nobody can sign in as them.
const backs = (cricket, f1, basketball, hockey) => Object.fromEntries(Object.entries({ cricket, f1, basketball, hockey })
  .filter(([, team]) => team !== undefined).map(([sport, team]) => [sport, { team, picks: [] }]));
export const DEMO_FRIENDS = [
  { handle: 'demo_aarav', name: 'Aarav (demo)', sports: backs('CSK', 'MCL', 'GSW', 'EDM') },
  { handle: 'demo_diya', name: 'Diya (demo)', sports: backs('MI', 'FER', 'LAL') },
  { handle: 'demo_kabir', name: 'Kabir (demo)', sports: backs('CSK', 'RBR', undefined, 'TOR') },
  { handle: 'demo_meera', name: 'Meera (demo)', sports: backs('MI', 'MCL', 'GSW', 'TOR') },
  { handle: 'demo_rohan', name: 'Rohan (demo)', sports: backs(null) },
  { handle: 'demo_sana', name: 'Sana (demo)', sports: backs('MI', 'MER', 'LAL', 'EDM') },
];

let demoFriendsReady = false;

// Idempotent: safe on every start and on every instance. A demo friend's teams are refreshed; a handle a real
// person owns is never touched.
export async function ensureDemoFriends(db) {
  if (demoFriendsReady) return;
  for (const f of DEMO_FRIENDS) {
    await db.query(
      `INSERT INTO users (id, handle, display_name, sports, is_demo) VALUES ($1, $2, $3, $4::jsonb, true)
       ON CONFLICT (handle) DO UPDATE SET sports = EXCLUDED.sports WHERE users.is_demo`,
      [newId('usr'), f.handle, f.name, JSON.stringify(f.sports)]);
  }
  demoFriendsReady = true;
}

export function resetDemoFriendsFlag() {
  demoFriendsReady = false;
}

export async function demoFriends(db, user) {
  const rows = await many(db,
    `SELECT id, handle, display_name AS name, sports, true AS demo FROM users WHERE is_demo AND id <> $1 ORDER BY handle LIMIT 10`,
    [user.id]);
  return { users: rows.map(({ sports, ...u }) => ({ ...u, teams: teamsOf(sports) })) };
}
