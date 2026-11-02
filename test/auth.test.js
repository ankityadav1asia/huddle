import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client, signUp } from './helpers.js';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

test('joining as a guest creates a profile and a session, with no phone or password', async () => {
  const c = client(app.base);
  const r = await c.post('/api/auth/guest', { display_name: 'Riya', handle: '@Riya_Sixes', team: 'CSK' });
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.body.user).sort(), ['display_name', 'handle', 'id', 'is_moderator', 'team']);
  assert.equal(r.body.user.handle, 'riya_sixes');
  assert.ok(c.cookie.startsWith('huddle_session='));
  assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  const me = await c.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.handle, 'riya_sixes');
  assert.equal((await c.get('/api/rooms')).status, 200);
});

test('names and handles are validated, unique and safety-checked; privileged fields are refused', async () => {
  const c = client(app.base);
  const join = (body) => c.post('/api/auth/guest', body);
  assert.equal((await join({ display_name: 'X', handle: 'ab' })).status, 400); // too short
  assert.equal((await join({ display_name: 'X', handle: 'has space' })).status, 400);
  assert.equal((await join({ display_name: 'X', handle: 'huddle' })).status, 400); // reserved
  assert.equal((await join({ display_name: 'tu chutiya hai', handle: 'fine_handle' })).status, 400);
  assert.equal((await join({ display_name: 'X', handle: 'call_9876543210' })).status, 400); // personal data in a label
  assert.equal((await join({ display_name: 'X', handle: 'team_test', team: 'RCB' })).status, 400);
  assert.equal((await join({ display_name: 'X', handle: 'sneaky_mod', is_moderator: true })).status, 400);
  assert.equal((await join({ display_name: 'First', handle: 'taken_one' })).status, 201);
  const dup = await client(app.base).post('/api/auth/guest', { display_name: 'Second', handle: 'Taken_One' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'handle_taken');
});

test('new profiles are limited per network, so nobody can mint accounts to dodge the chat limit', async () => {
  app.cfg.guest.perIpPerHour = 2;
  await app.db.query('DELETE FROM rate_events');
  assert.equal((await client(app.base).post('/api/auth/guest', { display_name: 'A', handle: 'limit_a' })).status, 201);
  assert.equal((await client(app.base).post('/api/auth/guest', { display_name: 'B', handle: 'limit_b' })).status, 201);
  const third = await client(app.base).post('/api/auth/guest', { display_name: 'C', handle: 'limit_c' });
  assert.equal(third.status, 429);
  assert.ok(third.body.error.retry_after > 0);
  app.cfg.guest.perIpPerHour = 10_000;
});

test('protected endpoints need a session, and signing out ends it', async () => {
  assert.equal((await client(app.base).get('/api/rooms')).status, 401);
  const c = await signUp(app.base, 'leaver_1');
  assert.equal((await c.post('/api/auth/logout')).status, 200);
  assert.equal((await c.get('/api/me')).status, 401);
});

test('moderators are recognised by account id only, never by a name anyone could pick', async () => {
  const mod = await signUp(app.base, 'real_mod');
  const copycat = await signUp(app.base, 'real_mod_2');
  app.cfg.moderatorUserIds = [mod.user.id];
  assert.equal((await mod.get('/api/me')).body.user.is_moderator, true);
  assert.equal((await copycat.get('/api/me')).body.user.is_moderator, false);
  app.cfg.moderatorUserIds = [];
});

test('without a server secret, joining fails closed', async () => {
  const secret = app.cfg.secret;
  app.cfg.secret = '';
  const r = await client(app.base).post('/api/auth/guest', { display_name: 'Nope', handle: 'no_secret' });
  assert.equal(r.status, 503);
  assert.equal((await client(app.base).get('/api/config')).body.auth.available, false);
  app.cfg.secret = secret;
});

test('user search returns public profile fields only', async () => {
  const a = await signUp(app.base, 'searcher_1');
  await signUp(app.base, 'kavya_kc');
  const r = await a.get('/api/users/search?q=kav');
  assert.equal(r.body.users.length, 1);
  assert.deepEqual(Object.keys(r.body.users[0]).sort(), ['demo', 'handle', 'id', 'name', 'team']);
});
