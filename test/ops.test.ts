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

test('Match Intelligence is served to members with source and freshness labels', async () => {
  const r = await fan.get(`/api/rooms/${roomId}/match`);
  assert.equal(r.status, 200);
  assert.equal(r.body.match.source, 'demo_fixture');
  assert.match(r.body.match.source_label, /Simulated replay/);
  assert.equal(r.body.score.target, 187);
  assert.ok('stale' in r.body.freshness);
  assert.ok(Array.isArray(r.body.score.batters));
});

test('demo controls jump the replay and can be switched off', async () => {
  const jump = await fan.post(`/api/demo/matches/${matchId}/jump`, { moment: 'drop' });
  assert.equal(jump.status, 200);
  assert.equal(jump.body.jumped_to, 'Dropped catch');
  const snap = await fan.get(`/api/rooms/${roomId}/match`);
  assert.ok(snap.body.rev >= 27); // everything before the dropped catch (fixture item 28) is now ingested
  assert.equal((await fan.post(`/api/demo/matches/${matchId}/jump`, { moment: 'bowling-change' })).status, 409); // already past
  app.cfg.demoControls = false;
  assert.equal((await fan.post(`/api/demo/matches/${matchId}/jump`, { moment: 'last-over' })).status, 403);
  app.cfg.demoControls = true;
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
