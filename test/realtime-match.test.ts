import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, signUp } from './helpers.ts';
import { DEMO_FIXTURE, schedule } from '../lib/match/fixture.ts';

// Serverless mode, as on Vercel: no background worker, so waiting long-polls run the match feed themselves.
let app; let fan; let roomId;
before(async () => {
  app = await startApp((cfg) => { cfg.worker.inline = false; });
  fan = await signUp(app.base, 'rt_fan');
  roomId = (await fan.get('/api/rooms')).body.public_rooms[0].id;
  assert.equal((await fan.post(`/api/rooms/${roomId}/join`)).status, 200); // starts the shared replay
});
after(async () => { await app.close(); });

test('opening a room counts you as online straight away', async () => {
  const boot = (await fan.get(`/api/rooms/${roomId}`)).body;
  assert.ok(boot.presence.online.includes(fan.user.id));
});

test('a long-poll answers as soon as the match moves, even when nobody is chatting', async () => {
  const boot = (await fan.get(`/api/rooms/${roomId}`)).body;
  // The next ball falls due half a second from now.
  const offsets = schedule(DEMO_FIXTURE, app.cfg.match.ballSeconds);
  await app.db.query(`UPDATE matches SET feed_started_at = now() - $2::float8 * interval '1 second' WHERE id = $1`, [boot.room.match.id, offsets[0] - 0.5]);
  const started = Date.now();
  const r = await fan.get(`/api/rooms/${roomId}/events?after=${boot.cursor}&wait=1&rev=${encodeURIComponent(boot.match_rev)}`);
  const took = Date.now() - started;
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.events, []); // no chat: the match alone ended the wait
  assert.notEqual(r.body.match_rev, boot.match_rev);
  assert.ok(took < 8000, `answered after ${took} ms, not at the 20 s deadline`);
  assert.ok(r.body.presence.online.includes(fan.user.id));
  // The client's next poll, with the new version, has nothing to wait for yet.
  const quick = await fan.get(`/api/rooms/${roomId}/events?after=${r.body.cursor}&rev=${encodeURIComponent(r.body.match_rev)}`);
  assert.equal(quick.body.match_rev, r.body.match_rev);
});
