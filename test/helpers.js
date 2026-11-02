// Test harness: the real HTTP API on an ephemeral port, backed by an in-memory PGlite database.
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readConfig, setConfig } from '../lib/config.js';
import { openPglite, setDb } from '../lib/db/index.js';
import { migrate } from '../lib/db/migrate.js';
import { setAi } from '../lib/ai/index.js';
import { createOrchestrator } from '../lib/ai/orchestrator.js';
import { setLogSink } from '../lib/log.js';
import { clearMatchCache } from '../lib/match/feed.js';

export const logs = [];

export async function startApp(tweak = () => {}) {
  process.env.HUDDLE_SECRET = 'test-secret-not-real';
  const cfg = readConfig();
  cfg.dataDir = mkdtempSync(path.join(tmpdir(), 'huddle-test-'));
  cfg.guest.perIpPerHour = 10_000;
  cfg.rooms.maxActiveOwned = 1000;
  cfg.worker.inline = true;
  cfg.demoControls = true;
  cfg.match.defaultSpeed = 1; // tests compute ball timings at 1x
  cfg.push.publicKey = '';
  cfg.push.privateKey = '';
  for (const p of Object.values(cfg.ai.providers)) p.apiKey = '';
  tweak(cfg);
  setConfig(cfg);
  setLogSink((line) => logs.push(line));
  clearMatchCache();
  const db = await openPglite(null);
  await migrate(db);
  setDb(db);
  setAi(createOrchestrator({ providers: [] }));
  const { handleApi } = await import('../lib/http/app.js');
  const server = http.createServer((req, res) => handleApi(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    db, cfg, base,
    async close() {
      await new Promise((r) => server.close(r));
      await db.close();
    },
  };
}

export function client(base) {
  let cookie = '';
  const c = {
    async req(method, url, body, headers = {}) {
      const res = await fetch(base + url, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = text; }
      return { status: res.status, body: json, headers: res.headers };
    },
    get: (url) => c.req('GET', url),
    post: (url, body = {}) => c.req('POST', url, body),
    put: (url, body = {}) => c.req('PUT', url, body),
    patch: (url, body = {}) => c.req('PATCH', url, body),
    del: (url) => c.req('DELETE', url),
    get cookie() { return cookie; },
  };
  return c;
}

// Joins as a guest (display name + handle) and returns a client holding that session.
export async function signUp(base, handle, { team = 'CSK' } = {}) {
  const c = client(base);
  const r = await c.post('/api/auth/guest', { display_name: handle, handle, team });
  if (r.status !== 201) throw new Error(`guest join failed: ${JSON.stringify(r.body)}`);
  c.user = r.body.user;
  return c;
}

// A second signed-in device for an existing user (a guest cannot sign in again, so the test mints a session).
export async function secondDevice(app, userId) {
  const { createSession } = await import('../lib/auth/sessions.js');
  const { token } = await createSession(app.db, userId);
  const c = client(app.base);
  const cookie = `huddle_session=${token}`;
  return Object.assign(c, {
    get: (u) => c.req('GET', u, undefined, { cookie }),
    post: (u, b = {}) => c.req('POST', u, b, { cookie }),
  });
}

export const msgId = () => `t${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;

// Let the cooldown pass without waiting for it in real time.
export async function clearCooldown(db, userId) {
  await db.query('UPDATE user_send_cooldowns SET next_allowed_at = now() - interval \'1 second\' WHERE user_id = $1', [userId]);
}

export async function makePrivateRoom(app, owner, invitees = [], extra = {}) {
  const matchId = (await app.db.query(
    `SELECT id FROM matches WHERE status IN ('scheduled','live') AND room_id IS NULL AND fixture_key = 'mi-csk-demo' ORDER BY created_at DESC LIMIT 1`)).rows[0]?.id;
  const r = await owner.post('/api/rooms', { name: 'Friends room', moderation_level: 'balanced', match_id: matchId, invitee_ids: invitees.map((u) => u.user.id), ...extra });
  if (r.status !== 201) throw new Error(`room create failed: ${JSON.stringify(r.body)}`);
  for (const u of invitees) {
    const inv = (await u.get('/api/me/invitations')).body.invitations.find((i) => i.room_id === r.body.room_id);
    const a = await u.post(`/api/invitations/${inv.id}/accept`);
    if (a.status !== 200) throw new Error(`accept failed: ${JSON.stringify(a.body)}`);
  }
  return r.body.room_id;
}
