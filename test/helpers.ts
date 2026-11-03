// Test harness: the real HTTP API on an ephemeral port, backed by an in-memory PGlite database.
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { readConfig, setConfig, type Config } from '../lib/config.ts';
import { openPglite, setDb, type Db } from '../lib/db/index.ts';
import { migrate } from '../lib/db/migrate.ts';
import { setAi } from '../lib/ai/index.ts';
import { createOrchestrator } from '../lib/ai/orchestrator.ts';
import { setLogSink } from '../lib/log.ts';
import { clearMatchCache } from '../lib/match/feed.ts';

export const logs: string[] = [];

export interface App {
  db: Db;
  cfg: Config;
  base: string;
  close(): Promise<void>;
}

// A signed-in (or anonymous) API client. Bodies are untyped JSON: each test knows what it asked for.
export interface Client {
  req(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any; headers: Headers }>;
  get(url: string): Promise<{ status: number; body: any; headers: Headers }>;
  post(url: string, body?: unknown): Promise<{ status: number; body: any; headers: Headers }>;
  put(url: string, body?: unknown): Promise<{ status: number; body: any; headers: Headers }>;
  patch(url: string, body?: unknown): Promise<{ status: number; body: any; headers: Headers }>;
  del(url: string): Promise<{ status: number; body: any; headers: Headers }>;
  readonly cookie: string;
  user?: any;
}

export async function startApp(tweak: (cfg: Config) => void = () => {}): Promise<App> {
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
  const { handleApi } = await import('../lib/http/app.ts');
  const server = http.createServer((req, res) => handleApi(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    db, cfg, base,
    async close() {
      await new Promise((r) => server.close(r));
      await db.close();
    },
  };
}

export function client(base: string): Client {
  let cookie = '';
  const c: Client = {
    async req(method, url, body, headers = {}) {
      const res = await fetch(base + url, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
      const text = await res.text();
      let json: any = null;
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

// Joins as a guest (display name + handle, backing a cricket team) and returns a client holding that session.
export async function signUp(base: string, handle: string, { team = 'CSK' } = {}): Promise<Client> {
  const c = client(base);
  const r = await c.post('/api/auth/guest', { display_name: handle, handle, sports: { cricket: { team } } });
  if (r.status !== 201) throw new Error(`guest join failed: ${JSON.stringify(r.body)}`);
  c.user = r.body.user;
  return c;
}

// A second signed-in device for an existing user (a guest cannot sign in again, so the test mints a session).
export async function secondDevice(app: App, userId: string): Promise<Client> {
  const { createSession } = await import('../lib/auth/sessions.ts');
  const { token } = await createSession(app.db, userId);
  const c = client(app.base);
  const cookie = `huddle_session=${token}`;
  return Object.assign(c, {
    get: (u) => c.req('GET', u, undefined, { cookie }),
    post: (u, b = {}) => c.req('POST', u, b, { cookie }),
  });
}

export const msgId = (): string => `t${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;

// Let the cooldown pass without waiting for it in real time.
export async function clearCooldown(db: Db, userId: string) {
  await db.query('UPDATE user_send_cooldowns SET next_allowed_at = now() - interval \'1 second\' WHERE user_id = $1', [userId]);
}

export async function makePrivateRoom(app: App, owner: Client, invitees: Client[] = [], extra: Record<string, unknown> = {}): Promise<string> {
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
