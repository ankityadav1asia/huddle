import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, signUp, makePrivateRoom } from './helpers.js';

let app; let owner; let friend; let outsider; let other;
before(async () => {
  app = await startApp();
  owner = await signUp(app.base, 'owner_one');
  friend = await signUp(app.base, 'friend_two');
  outsider = await signUp(app.base, 'outsider_3');
  other = await signUp(app.base, 'other_four');
  await owner.get('/api/rooms'); // provisions the demo match and its public room
});
after(async () => { await app.close(); });

test('a creator can make a private room, invite several people and becomes owner', async () => {
  const r = await owner.post('/api/rooms', { name: 'Chennai crew', moderation_level: 'relaxed', invitee_ids: [friend.user.id, other.user.id] });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.invitations.map((i) => i.result), ['invited', 'invited']);
  const room = await owner.get(`/api/rooms/${r.body.room_id}`);
  assert.equal(room.body.room.my_role, 'owner');
  assert.equal(room.body.room.moderation.level, 'relaxed');
  const list = await owner.get(`/api/rooms/${r.body.room_id}/invitations`);
  assert.deepEqual(list.body.invitations.map((i) => i.status), ['pending', 'pending']);
});

test('invalid moderation levels and client-supplied privileged fields are rejected', async () => {
  assert.equal((await owner.post('/api/rooms', { name: 'X', moderation_level: 'off' })).status, 400);
  assert.equal((await owner.post('/api/rooms', { name: 'X', room_type: 'public' })).status, 400);
  assert.equal((await owner.post('/api/rooms', { name: 'X', creator_id: friend.user.id })).status, 400);
});

test('a non-member cannot read, poll or post in a private room, and gets the same answer as a missing room', async () => {
  const roomId = await makePrivateRoom(app, owner, [friend]);
  for (const res of [
    await outsider.get(`/api/rooms/${roomId}`),
    await outsider.get(`/api/rooms/${roomId}/events?after=0`),
    await outsider.get(`/api/rooms/${roomId}/match`),
    await outsider.post(`/api/rooms/${roomId}/messages`, { client_msg_id: 'abcdefgh1', text: 'hello' }),
    await outsider.post(`/api/rooms/${roomId}/catchup`, {}),
  ]) assert.equal(res.status, 404);
  const missing = await outsider.get('/api/rooms/room_00000000000000000000');
  assert.deepEqual(missing.body, (await outsider.get(`/api/rooms/${roomId}`)).body);
});

test('a member of one private room cannot reach another by changing the room id', async () => {
  const roomA = await makePrivateRoom(app, owner, [friend]);
  const roomB = await makePrivateRoom(app, other, [outsider]);
  assert.equal((await friend.get(`/api/rooms/${roomA}`)).status, 200);
  assert.equal((await friend.get(`/api/rooms/${roomB}`)).status, 404);
  assert.equal((await friend.get(`/api/rooms/${roomB}/events?after=0`)).status, 404);
});

test('only the intended recipient can accept an invitation', async () => {
  const r = await owner.post('/api/rooms', { name: 'Invite test', invitee_ids: [friend.user.id] });
  const inv = (await friend.get('/api/me/invitations')).body.invitations.find((i) => i.room_id === r.body.room_id);
  assert.equal((await outsider.post(`/api/invitations/${inv.id}/accept`)).status, 404);
  assert.equal((await friend.post(`/api/invitations/${inv.id}/accept`)).status, 200);
  assert.equal((await friend.post(`/api/invitations/${inv.id}/accept`)).status, 409); // already consumed
});

test('expired and revoked invitations cannot be accepted', async () => {
  const r = await owner.post('/api/rooms', { name: 'Expiry test', invitee_ids: [friend.user.id, other.user.id] });
  const invs = (await owner.get(`/api/rooms/${r.body.room_id}/invitations`)).body.invitations;
  const toFriend = invs.find((i) => i.user_id === friend.user.id);
  const toOther = invs.find((i) => i.user_id === other.user.id);
  await app.db.query(`UPDATE room_invitations SET expires_at = now() - interval '1 minute' WHERE id = $1`, [toFriend.id]);
  assert.equal((await friend.post(`/api/invitations/${toFriend.id}/accept`)).status, 410);
  assert.equal((await owner.post(`/api/invitations/${toOther.id}/revoke`)).status, 200);
  assert.equal((await other.post(`/api/invitations/${toOther.id}/accept`)).status, 409);
});

test('nobody can give themselves owner or admin, and only owners/admins invite or change settings', async () => {
  const roomId = await makePrivateRoom(app, owner, [friend, other]);
  assert.equal((await friend.put(`/api/rooms/${roomId}/members/${friend.user.id}/role`, { role: 'admin' })).status, 403);
  assert.equal((await friend.put(`/api/rooms/${roomId}/members/${other.user.id}/role`, { role: 'admin' })).status, 403);
  assert.equal((await owner.put(`/api/rooms/${roomId}/members/${friend.user.id}/role`, { role: 'owner' })).status, 400);
  assert.equal((await friend.post(`/api/rooms/${roomId}/invitations`, { invitee_ids: [outsider.user.id] })).status, 403);
  assert.equal((await friend.patch(`/api/rooms/${roomId}/settings`, { moderation_level: 'relaxed' })).status, 403);
  assert.equal((await owner.put(`/api/rooms/${roomId}/members/${friend.user.id}/role`, { role: 'admin' })).status, 200);
  assert.equal((await friend.post(`/api/rooms/${roomId}/invitations`, { invitee_ids: [outsider.user.id] })).status, 200);
  assert.equal((await friend.patch(`/api/rooms/${roomId}/settings`, { moderation_level: 'strict' })).status, 200);
  assert.equal((await friend.patch(`/api/rooms/${roomId}/settings`, { moderation_level: 'loose' })).status, 400);
  assert.equal((await friend.del(`/api/rooms/${roomId}/members/${owner.user.id}`)).status, 403);
});

test('public room moderation is server-controlled and cannot be set by any client', async () => {
  const pub = (await owner.get('/api/rooms')).body.public_rooms[0];
  assert.ok(pub);
  assert.equal((await owner.post(`/api/rooms/${pub.id}/join`)).status, 200);
  const room = await owner.get(`/api/rooms/${pub.id}`);
  assert.equal(room.body.room.moderation.managed_by, 'huddle');
  assert.equal(room.body.room.moderation.level, null);
  assert.equal((await owner.patch(`/api/rooms/${pub.id}/settings`, { moderation_level: 'relaxed' })).status, 403);
  const stored = (await app.db.query('SELECT moderation_level FROM rooms WHERE id = $1', [pub.id])).rows[0];
  assert.equal(stored.moderation_level, null);
});

test('leaving a room revokes access immediately; the owner cannot leave', async () => {
  const roomId = await makePrivateRoom(app, owner, [friend]);
  assert.equal((await owner.post(`/api/rooms/${roomId}/leave`)).status, 409);
  assert.equal((await friend.post(`/api/rooms/${roomId}/leave`)).status, 200);
  assert.equal((await friend.get(`/api/rooms/${roomId}/events?after=0`)).status, 404);
});
