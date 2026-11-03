import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, signUp, secondDevice } from './helpers.ts';
import { ensureDemoMatch } from '../lib/match/feed.ts';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

test('"sign out on all devices" revokes every session', async () => {
  const a = await signUp(app.base, 'multi_device');
  const second = await secondDevice(app, a.user.id);
  assert.equal((await second.get('/api/me')).status, 200);
  assert.equal((await a.post('/api/auth/logout-all')).status, 200);
  assert.equal((await a.get('/api/me')).status, 401);
  assert.equal((await second.get('/api/me')).status, 401);
});

test('public watch parties hold at most PUBLIC_ROOM_MAX_MEMBERS, and finished matches are not offered', async () => {
  app.cfg.rooms.publicMaxMembers = 2;
  const [x, y, z] = await Promise.all(['cap_x', 'cap_y', 'cap_z'].map((h) => signUp(app.base, h)));
  const pub = (await x.get('/api/rooms')).body.public_rooms[0];
  assert.equal(pub.max_members, 2);
  assert.equal((await x.post(`/api/rooms/${pub.id}/join`)).status, 200);
  assert.equal((await y.post(`/api/rooms/${pub.id}/join`)).status, 200);
  const third = await z.post(`/api/rooms/${pub.id}/join`);
  assert.equal(third.status, 409);
  assert.equal(third.body.error.code, 'room_full');
  assert.equal((await z.get('/api/rooms')).body.public_rooms.find((r) => r.id === pub.id).full, true);
  assert.equal((await x.post(`/api/rooms/${pub.id}/join`)).status, 200); // members can come back
  app.cfg.rooms.publicMaxMembers = 100;

  await app.db.query(`UPDATE matches SET status = 'completed' WHERE id = $1`, [pub.match_id]);
  await ensureDemoMatch(app.db);
  const listed = (await x.get('/api/rooms')).body.public_rooms;
  assert.deepEqual(listed.map((r) => r.sport), ['cricket', 'f1', 'basketball', 'hockey']); // one public watch party per sport
  assert.ok(!listed.some((r) => r.id === pub.id)); // the finished game's room is no longer offered
});
