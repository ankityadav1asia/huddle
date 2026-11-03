import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, signUp, client, makePrivateRoom, type App, type Client } from './helpers.ts';

let app: App; let mod: Client; let fan: Client; let roomId: string; let matchId: string;
before(async () => {
  app = await startApp((cfg) => { cfg.cronSecret = 'cron-test-secret'; });
  mod = await signUp(app.base, 'ops_mod');
  app.cfg.moderatorUserIds = [mod.user.id];
  fan = await signUp(app.base, 'ops_fan');
  await fan.get('/api/rooms');
  roomId = await makePrivateRoom(app, fan, []);
  matchId = (await app.db.query('SELECT match_id FROM rooms WHERE id = $1', [roomId])).rows[0].match_id;
});
after(async () => { await app.close(); });

// What the app shows people never calls the game simulated, a demo or a replay (docs and code comments still do).
const UNSHOWN = /simulat|demo|replay|made.up|illustrative/i;

test('Match Intelligence is served to members with source and freshness labels', async () => {
  const r = await fan.get(`/api/rooms/${roomId}/match`);
  assert.equal(r.status, 200);
  assert.equal(r.body.match.source, 'demo_fixture'); // an internal source id, not a label
  assert.equal(r.body.match.source_label, 'Ball-by-ball match feed');
  assert.equal(r.body.score.target, 187);
  assert.ok('stale' in r.body.freshness);
  assert.ok(Array.isArray(r.body.score.batters));
  assert.equal('replay' in r.body, false);
  assert.equal('moments' in r.body, false);
});

test('labels, notices, rules and examples never call the game simulated, a demo or a replay', async () => {
  const { body: boot } = await fan.get(`/api/rooms/${roomId}`);
  const { body: guide } = await fan.get(`/api/rooms/${roomId}/guide`);
  const { body: snap } = await fan.get(`/api/rooms/${roomId}/match?detail=1`);
  const { body: config } = await fan.get('/api/config');
  const shown = [boot.room.ai_notice, boot.room.retention_notice, boot.room.moderation.notice, JSON.stringify(guide), snap.match.source_label,
    ...snap.commentary.map((c: { label: string | null; text: string }) => `${c.label} ${c.text}`), JSON.stringify(config)];
  for (const text of shown) assert.doesNotMatch(String(text), UNSHOWN);
  const { FIXTURE_ORDER } = await import('../lib/match/fixture.ts');
  for (const f of FIXTURE_ORDER) {
    assert.doesNotMatch(`${f.title} ${f.sourceLabel} ${JSON.stringify(f.rules)} ${f.examples.join(' ')}`, UNSHOWN, f.sport);
  }
});

test('removed endpoints answer 404', async () => {
  const removed: [string, string, unknown?][] = [
    ['POST', `/api/rooms/${roomId}/replay`, { action: 'pause' }],
    ['POST', `/api/demo/matches/${matchId}/jump`, { moment: 'drop' }],
    ['POST', '/api/demo/matches', {}],
    ['GET', '/api/me/notifications'],
    ['PUT', '/api/me/notifications', { push_momentum: false }],
    ['POST', '/api/me/push-subscriptions', { endpoint: 'https://push.example.test/x', keys: { p256dh: 'p', auth: 'a' } }],
    ['DELETE', '/api/me/push-subscriptions'],
    ['GET', '/api/users/demo'],
  ];
  for (const [method, url, body] of removed) {
    const r = await fan.req(method, url, body);
    assert.equal(r.status, 404, `${method} ${url}`);
    assert.equal(r.body.error.code, 'not_found');
  }
  const config = (await fan.get('/api/config')).body;
  for (const key of ['notifications', 'push', 'demo_controls']) assert.equal(key in config, false, key);
  assert.deepEqual(Object.keys(config).sort(), ['ai', 'auth', 'chat', 'crowd', 'max_picks', 'moderation', 'retention_hours', 'sports']);
});

test('ops metrics are for moderators only and carry no message text', async () => {
  assert.equal((await fan.get('/api/ops/metrics')).status, 403);
  const r = await mod.get('/api/ops/metrics');
  assert.equal(r.status, 200);
  for (const k of ['process', 'queue', 'ai', 'moderation', 'rooms']) assert.ok(k in r.body, k);
  assert.ok(r.body.rooms.active >= 1);
});

test('the cron sweep needs its bearer secret', async () => {
  const anon = client(app.base);
  assert.equal((await anon.get('/api/cron/sweep')).status, 401);
  assert.equal((await anon.req('GET', '/api/cron/sweep', undefined, { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await anon.req('GET', '/api/cron/sweep', undefined, { authorization: 'Bearer cron-test-secret' })).status, 200);
});

test('cross-site state changes are refused', async () => {
  const r = await fan.req('POST', `/api/rooms/${roomId}/leave`, {}, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'bad_origin');
});
