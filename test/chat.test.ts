import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, signUp, makePrivateRoom, msgId, clearCooldown, type App, type Client, type ApiEvent } from './helpers.ts';

let app: App; let a: Client; let b: Client; let roomId: string; let roomId2: string;
before(async () => {
  app = await startApp();
  a = await signUp(app.base, 'chat_a');
  b = await signUp(app.base, 'chat_b');
  await a.get('/api/rooms');
  roomId = await makePrivateRoom(app, a, [b]);
  roomId2 = await makePrivateRoom(app, a, [b]);
});
after(async () => { await app.close(); });

const send = (c: Client, room: string, text: string, extra: Record<string, unknown> = {}) => c.post(`/api/rooms/${room}/messages`, { client_msg_id: msgId(), text, ...extra });

test('a message is accepted, sequenced and delivered to other members through the event stream', async () => {
  const before = (await b.get(`/api/rooms/${roomId}`)).body.cursor;
  const r = await send(a, roomId, 'Dube is batting beautifully today');
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'visible');
  assert.ok(r.body.message.seq > before);
  const ev = await b.get(`/api/rooms/${roomId}/events?after=${before}`);
  const delivered = ev.body.events.find((e: ApiEvent) => e.type === 'message' && e.data.id === r.body.message.id);
  assert.equal(delivered.data.text, 'Dube is batting beautifully today');
  assert.equal(delivered.data.sender.handle, 'chat_a');
  assert.equal(delivered.data.sender.phone, undefined);
  await clearCooldown(app.db, a.user.id);
});

test('one accepted message per user every 10 seconds, across rooms and devices', async () => {
  await clearCooldown(app.db, a.user.id);
  assert.equal((await send(a, roomId, 'first one')).status, 201);
  const sameRoom = await send(a, roomId, 'second one');
  assert.equal(sameRoom.status, 429);
  assert.equal(sameRoom.body.error.code, 'cooldown');
  assert.equal(app.cfg.chat.cooldownSeconds, 10);
  assert.ok(sameRoom.body.error.retry_after > 5 && sameRoom.body.error.retry_after <= 10);
  assert.equal(sameRoom.headers.get('retry-after'), String(sameRoom.body.error.retry_after));
  assert.equal((await send(a, roomId2, 'other room')).status, 429);
  // A second "device": a fresh session for the same user.
  const c2 = await import('./helpers.ts').then((h) => h.secondDevice(app, a.user.id));
  assert.equal((await send(c2, roomId, 'from my phone')).status, 429);
  await clearCooldown(app.db, a.user.id);
});

test('the boundary is exact: the next message is allowed at accepted time + 10 s, not before', async () => {
  await clearCooldown(app.db, b.user.id);
  assert.equal((await send(b, roomId, 'boundary test')).status, 201);
  await app.db.query(`UPDATE user_send_cooldowns SET next_allowed_at = now() + interval '2 seconds' WHERE user_id = $1`, [b.user.id]);
  assert.equal((await send(b, roomId, 'too early')).status, 429);
  await app.db.query(`UPDATE user_send_cooldowns SET next_allowed_at = now() WHERE user_id = $1`, [b.user.id]);
  assert.equal((await send(b, roomId, 'exactly on time')).status, 201);
  await clearCooldown(app.db, b.user.id);
});

test('concurrent sends cannot bypass the limit', async () => {
  await clearCooldown(app.db, a.user.id);
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => send(a, i % 2 ? roomId : roomId2, `burst ${i}`)));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 429).length, 5);
  await clearCooldown(app.db, a.user.id);
});

test('a retried request with the same idempotency key returns the original message, not a duplicate', async () => {
  await clearCooldown(app.db, a.user.id);
  const key = msgId();
  const first = await a.post(`/api/rooms/${roomId}/messages`, { client_msg_id: key, text: 'only once please' });
  const retry = await a.post(`/api/rooms/${roomId}/messages`, { client_msg_id: key, text: 'only once please' });
  assert.equal(first.status, 201);
  assert.equal(retry.status, 201);
  assert.equal(retry.body.duplicate, true);
  assert.equal(retry.body.message.id, first.body.message.id);
  const n = (await app.db.query(`SELECT count(*)::int AS n FROM messages WHERE client_msg_id = $1`, [key])).rows[0].n;
  assert.equal(n, 1);
  await clearCooldown(app.db, a.user.id);
});

test('rejected messages are not stored, not broadcast and do not use up the cooldown', async () => {
  await clearCooldown(app.db, b.user.id);
  const cursor = (await a.get(`/api/rooms/${roomId}`)).body.cursor;
  const bad = await send(b, roomId, 'tujhe maar dunga');
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.code, 'message_rejected');
  assert.match(bad.body.error.message, /Threats/);
  assert.equal((await app.db.query(`SELECT count(*)::int AS n FROM messages WHERE body LIKE '%maar dunga%'`)).rows[0].n, 0);
  const audit = (await app.db.query(`SELECT * FROM moderation_events WHERE target_user_id = $1 AND event_type = 'message_rejected'`, [b.user.id])).rows;
  assert.ok(audit.length >= 1);
  assert.ok(audit.every((r) => !JSON.stringify(r).includes('maar')));
  assert.equal((await send(b, roomId, 'ok sorry, back to the cricket')).status, 201);
  const ev = await a.get(`/api/rooms/${roomId}/events?after=${cursor}`);
  assert.ok(!ev.body.events.some((e: ApiEvent) => e.data?.text?.includes('maar')));
  await clearCooldown(app.db, b.user.id);
  await app.db.query('DELETE FROM moderation_events WHERE target_user_id = $1', [b.user.id]);
});

test('uncertain high-risk text is held for review, never broadcast', async () => {
  await clearCooldown(app.db, b.user.id);
  const cursor = (await a.get(`/api/rooms/${roomId}`)).body.cursor;
  const held = await send(b, roomId, 'maar dalunga aaj');
  assert.equal(held.status, 201);
  assert.equal(held.body.status, 'held');
  assert.equal(held.body.message.seq, null);
  const ev = await a.get(`/api/rooms/${roomId}/events?after=${cursor}`);
  assert.equal(ev.body.events.length, 0);
  await clearCooldown(app.db, b.user.id);
});

test('relaxed mode still enforces the mandatory baseline; levels change only conversational strictness', async () => {
  const relaxed = await makePrivateRoom(app, a, [b], { moderation_level: 'relaxed' });
  for (const text of ['kill yourself', 'call me on 9876543210', 'send nudes']) {
    await clearCooldown(app.db, a.user.id);
    assert.equal((await send(a, relaxed, text)).status, 422, text);
  }
  // Three stopped messages in ten minutes pause posting for a short while (never a permanent ban).
  const paused = await send(a, relaxed, 'fine, fine');
  assert.equal(paused.status, 429);
  assert.equal(paused.body.error.code, 'moderation_pause');
  await app.db.query('DELETE FROM moderation_events WHERE target_user_id = $1', [a.user.id]);
  await clearCooldown(app.db, a.user.id);
  assert.equal((await send(a, relaxed, 'saala kya over tha, bc')).status, 201);
  const strict = await makePrivateRoom(app, a, [b], { moderation_level: 'strict' });
  await clearCooldown(app.db, a.user.id);
  assert.equal((await send(a, strict, 'saala kya over tha')).status, 422);
  // A policy change applies to the very next message.
  await a.patch(`/api/rooms/${strict}/settings`, { moderation_level: 'relaxed' });
  await clearCooldown(app.db, a.user.id);
  assert.equal((await send(a, strict, 'saala kya over tha')).status, 201);
  await clearCooldown(app.db, a.user.id);
  await app.db.query('DELETE FROM moderation_events WHERE target_user_id = $1', [a.user.id]);
});

test('ordinary Hinglish banter passes the public policy', async () => {
  const pub = (await a.get('/api/rooms')).body.public_rooms[0];
  await a.post(`/api/rooms/${pub.id}/join`);
  await clearCooldown(app.db, a.user.id);
  const r = await send(a, pub.id, 'Tilak?? Bumrah kahan hai 😡 bowling change samajh nahi aaya');
  assert.equal(r.status, 201);
  await clearCooldown(app.db, a.user.id);
});

test('files, attachments, unknown fields and oversized text are refused at the API boundary', async () => {
  await clearCooldown(app.db, a.user.id);
  const multipart = await a.req('POST', `/api/rooms/${roomId}/messages`, '--x\r\nContent-Disposition: form-data; name="file"\r\n\r\nabc\r\n--x--', { 'content-type': 'multipart/form-data; boundary=x' });
  assert.equal(multipart.status, 415);
  assert.equal((await a.post(`/api/rooms/${roomId}/messages`, { client_msg_id: msgId(), text: 'hi', attachment: 'data:image/png;base64,AAAA' })).status, 400);
  assert.equal((await a.post(`/api/rooms/${roomId}/messages`, { client_msg_id: msgId(), text: 'x'.repeat(501) })).status, 400);
  assert.equal((await a.post(`/api/rooms/${roomId}/messages`, { client_msg_id: msgId(), text: '   ' })).status, 400);
  assert.equal((await a.post(`/api/rooms/${roomId}/messages`, { client_msg_id: msgId(), text: 'hi', sender_id: b.user.id })).status, 400);
});

test('reactions accept only allowlisted emoji and are idempotent', async () => {
  await clearCooldown(app.db, a.user.id);
  const m = await send(a, roomId, 'what a yorker');
  const url = `/api/rooms/${roomId}/messages/${m.body.message.id}/reactions`;
  assert.equal((await b.put(url, { emoji: '🔥', on: true })).status, 200);
  assert.equal((await b.put(url, { emoji: '🔥', on: true })).status, 200);
  assert.equal((await b.put(url, { emoji: '💩', on: true })).status, 400);
  const room = await b.get(`/api/rooms/${roomId}`);
  const msg = room.body.items.find((i: ApiEvent) => i.data.id === m.body.message.id);
  assert.deepEqual(msg.data.reactions, [{ emoji: '🔥', count: 1, mine: true }]);
  await clearCooldown(app.db, a.user.id);
});

test('a long-poll wakes up as soon as a message arrives', async () => {
  await clearCooldown(app.db, a.user.id);
  const cursor = (await b.get(`/api/rooms/${roomId}`)).body.cursor;
  const started = Date.now();
  const waiting = b.get(`/api/rooms/${roomId}/events?after=${cursor}&wait=1`);
  await new Promise((r) => setTimeout(r, 300));
  await send(a, roomId, 'wake up');
  const ev = await waiting;
  assert.ok(Date.now() - started < 5000);
  assert.ok(ev.body.events.some((e: ApiEvent) => e.data?.text === 'wake up'));
  await clearCooldown(app.db, a.user.id);
});

test('ending a room revokes history immediately, rejects new messages and replays nothing on reconnect', async () => {
  const r = await makePrivateRoom(app, a, [b]);
  await clearCooldown(app.db, a.user.id);
  await send(a, r, 'secret plans for the last over');
  assert.equal((await b.post(`/api/rooms/${r}/end`)).status, 403); // members cannot end it
  assert.equal((await a.post(`/api/rooms/${r}/end`)).status, 200);
  const boot = await b.get(`/api/rooms/${r}`);
  assert.equal(boot.body.room.status, 'ended');
  assert.deepEqual(boot.body.items, []);
  const ev = await b.get(`/api/rooms/${r}/events?after=0`);
  assert.deepEqual(ev.body.events, []);
  assert.equal(ev.body.room.status, 'ended');
  await clearCooldown(app.db, b.user.id);
  const late = await send(b, r, 'anyone here?');
  assert.equal(late.status, 410);
  assert.equal((await a.post(`/api/rooms/${r}/catchup`, {})).status, 410);
  // Bodies still exist until the retention purge, but no user-facing path returns them.
  const stored = (await app.db.query('SELECT count(*)::int AS n FROM messages WHERE room_id = $1', [r])).rows[0].n;
  assert.ok(stored >= 1);
});
