import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client, signUp, type App, type Client, type ApiInvitation, type ApiUser } from './helpers.ts';
import { ensureDemoFriends, resetDemoFriendsFlag, DEMO_FRIENDS } from '../lib/users.ts';

let app: App; let host: Client;
before(async () => {
  resetDemoFriendsFlag();
  app = await startApp();
  host = await signUp(app.base, 'party_host');
  await host.get('/api/rooms'); // seeds the demo match and the demo friends
});
after(async () => { await app.close(); });

test('at least five clearly labelled demo friends exist, created once', async () => {
  resetDemoFriendsFlag();
  await ensureDemoFriends(app.db); // a second run (restart, another instance) adds nothing
  const rows = (await app.db.query('SELECT handle, display_name, is_demo FROM users WHERE is_demo ORDER BY handle')).rows;
  assert.ok(rows.length >= 5);
  assert.equal(rows.length, DEMO_FRIENDS.length);
  for (const r of rows) {
    assert.match(r.handle, /^demo_/);
    assert.match(r.display_name, /\(demo\)$/);
  }
  const sessions = (await app.db.query('SELECT count(*)::int AS n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.is_demo')).rows[0].n;
  assert.equal(sessions, 0); // nobody can be signed in as a demo friend
});

test('demo friends are offered in the invite picker and marked in search', async () => {
  const list = await host.get('/api/users/demo');
  assert.equal(list.status, 200);
  assert.ok(list.body.users.length >= 5);
  assert.ok(list.body.users.every((u: ApiUser) => u.demo === true));
  const search = await host.get('/api/users/search?q=demo');
  assert.ok(search.body.users.length >= 5 && search.body.users.every((u: ApiUser) => u.demo === true));
  const real = await signUp(app.base, 'real_friend');
  const mixed = await host.get('/api/users/search?q=real');
  assert.equal(mixed.body.users.find((u: ApiUser) => u.handle === 'real_friend').demo, false);
  assert.ok(real.user.id);
});

test('a private room can invite demo friends; their invitations stay pending', async () => {
  const demo = (await host.get('/api/users/demo')).body.users.slice(0, 3);
  const r = await host.post('/api/rooms', { name: 'Demo invite room', invitee_ids: demo.map((u: ApiUser) => u.id) });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.invitations.map((i: ApiInvitation) => i.result), ['invited', 'invited', 'invited']);
  const invites = (await host.get(`/api/rooms/${r.body.room_id}/invitations`)).body.invitations;
  assert.equal(invites.length, 3);
  assert.ok(invites.every((i: ApiInvitation) => i.status === 'pending'));
});

test('nobody can join with a demo_ handle, so a real person is never mistaken for a demo friend', async () => {
  const r = await client(app.base).post('/api/auth/guest', { display_name: 'Faker', handle: 'demo_faker' });
  assert.equal(r.status, 400);
  const taken = await client(app.base).post('/api/auth/guest', { display_name: 'Aarav', handle: 'demo_aarav' });
  assert.equal(taken.status, 400);
});

test('DEMO_USERS=false hides demo friends from the picker and from search', async () => {
  app.cfg.demoFriends = false;
  assert.deepEqual((await host.get('/api/users/demo')).body.users, []);
  assert.deepEqual((await host.get('/api/users/search?q=demo_')).body.users, []);
  app.cfg.demoFriends = true;
  assert.ok((await host.get('/api/users/search?q=demo_')).body.users.length >= 5);
});
