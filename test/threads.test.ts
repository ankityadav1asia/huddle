import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, signUp, makePrivateRoom, clearCooldown, msgId } from './helpers.ts';
import { ensureDemoMatch, ingestDue } from '../lib/match/feed.ts';
import { crowdLines } from '../lib/match/crowd.ts';
import { DEMO_FIXTURE, schedule } from '../lib/match/fixture.ts';
import { endRoom, purgeRoom } from '../lib/rooms/lifecycle.ts';

let app; let host; let friend; let shared; let roomA; let roomB;
const offsets = () => schedule(DEMO_FIXTURE, app.cfg.match.ballSeconds);
const idx = (pred) => DEMO_FIXTURE.items.findIndex(pred);
const threadsOf = async (room) => (await app.db.query('SELECT slug, source FROM room_threads WHERE room_id = $1 ORDER BY created_at', [room])).rows;
const say = async (c, room, text, extra = {}) => {
  await clearCooldown(app.db, c.user.id);
  const r = await c.post(`/api/rooms/${room}/messages`, { client_msg_id: msgId(), text, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.message;
};
// Play the shared replay up to fixture item `i` (inclusive), as fresh balls (not a jump).
async function playTo(i, { backfillUntil = -1 } = {}) {
  await app.db.query(`UPDATE matches SET status = 'live', backfill_until = $2, feed_started_at = now() - $3::float8 * interval '1 second' WHERE id = $1`,
    [shared, backfillUntil, offsets()[i] + 0.05]);
  await ingestDue(app.db, shared);
}

before(async () => {
  app = await startApp();
  host = await signUp(app.base, 'thr_host');
  friend = await signUp(app.base, 'thr_friend');
  await host.get('/api/rooms');
  shared = await ensureDemoMatch(app.db);
  roomA = await makePrivateRoom(app, host, [friend]); // both follow the shared replay
  roomB = await makePrivateRoom(app, friend, []);
});
after(async () => { await app.close(); });

test('big moments open a #thread in every room following the match, once each', async () => {
  const wicket = idx((x) => x.wicket?.out === 'Shivam Dube');
  await playTo(wicket);
  for (const room of [roomA, roomB]) {
    assert.deepEqual((await threadsOf(room)).map((t) => t.slug), ['bowling-change', 'dube-out']);
  }
  await playTo(wicket); // ingesting again opens nothing new
  assert.equal((await threadsOf(roomA)).length, 2);
  const boot = (await host.get(`/api/rooms/${roomA}`)).body;
  assert.deepEqual(boot.threads.map((t) => [t.title, t.source]), [['#bowling-change', 'moment'], ['#dube-out', 'moment']]);
  assert.match(boot.threads[1].about, /Shivam Dube out, c Suryakumar b Tilak/);
  const events = (await friend.get(`/api/rooms/${roomA}/events?after=0`)).body.events.filter((e) => e.type === 'thread');
  assert.deepEqual(events.map((e) => e.data.title), ['#bowling-change', '#dube-out']);
});

test('balls skipped by a jump open no threads', async () => {
  const drop = idx((x) => x.drop);
  await playTo(drop, { backfillUntil: drop }); // the DRS call and the dropped catch were skipped
  assert.ok(!(await threadsOf(roomA)).some((t) => ['drs-call', 'dropped-catch'].includes(t.slug)));
});

test('messages join the thread they are sent from, or one whose topic they mention', async () => {
  const [, dube] = (await host.get(`/api/rooms/${roomA}`)).body.threads;
  const sent = await say(host, roomA, 'What a catch that was', { thread_id: dube.id });
  assert.deepEqual(sent.thread, { id: dube.id, title: '#dube-out' });
  const mentioned = await say(friend, roomA, 'Dube should have stayed calm there');
  assert.equal(mentioned.thread.title, '#dube-out');
  await clearCooldown(app.db, friend.user.id);
  const wrong = await friend.post(`/api/rooms/${roomB}/messages`, { client_msg_id: msgId(), text: 'hello', thread_id: dube.id }); // another room's thread
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error.code, 'invalid_thread');
  const counts = (await host.get(`/api/rooms/${roomA}`)).body.threads.find((t) => t.id === dube.id).messages;
  assert.equal(counts, 2);
});

test('chat right after a big moment joins its thread', async () => {
  await app.db.query(`UPDATE room_threads SET created_at = now() - interval '10 minutes'`); // nothing is fresh
  assert.equal((await say(host, roomA, 'Kya match chal raha hai yaar')).thread, null);
  await app.db.query(`UPDATE room_threads SET created_at = now() WHERE slug = 'dube-out'`);
  assert.equal((await say(host, roomA, 'Kya match chal raha hai yaar')).thread.title, '#dube-out');
  assert.equal((await say(host, roomA, 'ok')).thread, null); // too short to tell
  await app.db.query(`UPDATE room_threads SET created_at = now() - interval '10 minutes'`);
});

test('a topic three messages from two people argue about becomes its own thread', async () => {
  const before = await say(host, roomA, 'That LBW looked plumb to me');
  assert.equal(before.thread, null);
  await say(friend, roomA, 'Umpire got it wrong, review it');
  assert.ok(!(await threadsOf(roomA)).some((t) => t.slug === 'drs-call')); // two messages: not yet
  await say(friend, roomA, 'DRS will save them');
  const drs = (await threadsOf(roomA)).find((t) => t.slug === 'drs-call');
  assert.deepEqual(drs, { slug: 'drs-call', source: 'discussion' });
  const tagged = (await app.db.query(
    `SELECT count(*)::int AS n FROM messages m JOIN room_threads t ON t.id = m.thread_id WHERE t.room_id = $1 AND t.slug = 'drs-call'`, [roomA])).rows[0].n;
  assert.equal(tagged, 3); // the earlier messages moved into it
  const updates = (await host.get(`/api/rooms/${roomA}/events?after=0`)).body.events.filter((e) => e.type === 'message_update' && e.data.thread?.title === '#drs-call');
  assert.ok(updates.length >= 3);
  assert.equal((await threadsOf(roomB)).some((t) => t.slug === 'drs-call'), false); // only this room argued about it
});

test("simulated fans' reactions to a big moment carry its thread", async () => {
  const wicket = idx((x) => x.wicket?.out === 'Shivam Dube');
  await app.db.query(`UPDATE matches SET feed_started_at = now() - $2::float8 * interval '1 second' WHERE id = $1`, [shared, offsets()[wicket] + 3]);
  await app.db.query(`UPDATE match_events SET occurred_at = now() - interval '3 seconds', backfilled = false WHERE match_id = $1 AND seq = $2`, [shared, wicket]);
  const lines = await crowdLines(app.db, { roomId: roomA, matchId: shared });
  const forWicket = lines.filter((c) => Number(c.id.split(':')[1]) === wicket);
  assert.ok(forWicket.length > 0 && forWicket.every((c) => c.thread === 'dube-out'));
});

test('threads are purged with the room', async () => {
  await endRoom(app.db, roomB, { reason: 'test' });
  assert.equal(await purgeRoom(app.db, roomB), 'purged');
  assert.equal((await threadsOf(roomB)).length, 0);
});
