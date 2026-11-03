import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, signUp, makePrivateRoom, type App, type Client, type ApiPublicRoom } from './helpers.ts';
import { ensureDemoMatch, ingestDue, clearMatchCache } from '../lib/match/feed.ts';
import { crowdLines } from '../lib/match/crowd.ts';
import { CROWD } from '../lib/match/demo-script.ts';

let app: App; let host: Client; let friend: Client; let shared: string; let pub: ApiPublicRoom;
const itemOf = (line: { id: string }) => Number(line.id.split(':')[1]);

// Plays the opening 25 seconds of the shared game again, so its first plays (and their crowd) are fresh.
async function freshStart() {
  await app.db.query('DELETE FROM match_events WHERE match_id = $1', [shared]);
  clearMatchCache();
  await app.db.query(`UPDATE matches SET status = 'live', feed_started_at = now() - interval '25 seconds' WHERE id = $1`, [shared]);
  await ingestDue(app.db, shared);
}

before(async () => {
  app = await startApp();
  host = await signUp(app.base, 'crowd_host');
  friend = await signUp(app.base, 'crowd_friend');
  pub = (await host.get('/api/rooms')).body.public_rooms.find((r: ApiPublicRoom) => r.sport === 'cricket');
  shared = await ensureDemoMatch(app.db);
  for (const c of [host, friend]) assert.equal((await c.post(`/api/rooms/${pub.id}/join`)).status, 200);
});
after(async () => { await app.close(); });

test('simulated fans are the same for everyone in the public watch party, and never stored as chat', async () => {
  await freshStart();
  const mine = (await host.get(`/api/rooms/${pub.id}/match`)).body.crowd;
  assert.ok(mine.length >= 5);
  assert.deepEqual((await friend.get(`/api/rooms/${pub.id}/match`)).body.crowd, mine);
  for (const c of mine) {
    assert.deepEqual(Object.keys(c).sort(), ['at', 'fan', 'id', 'team', 'text', 'thread']);
    assert.ok(['MI', 'CSK'].includes(c.team));
    assert.ok(!Number.isNaN(Date.parse(c.at)));
    assert.doesNotMatch(c.text, /\{\w+\}/); // placeholders are filled from the scorecard
  }
  assert.equal((await app.db.query(`SELECT count(*)::int AS n FROM messages WHERE room_id = $1`, [pub.id])).rows[0].n, 0);
  const boot = (await host.get(`/api/rooms/${pub.id}`)).body;
  assert.equal(boot.crowd_fans.length, 200);
});

test('private rooms hold only the people invited: no simulated fans, though they follow the same game', async () => {
  await freshStart();
  const roomId = await makePrivateRoom(app, host, [friend]);
  const snap = (await host.get(`/api/rooms/${roomId}/match`)).body;
  assert.equal(snap.match.id, shared);
  assert.deepEqual(snap.crowd, []);
  assert.deepEqual((await friend.get(`/api/rooms/${roomId}`)).body.crowd_fans, []);
});

test('the crowd is seeded per room', async () => {
  await freshStart();
  const said = async (roomId: string) => (await crowdLines(app.db, { roomId, matchId: shared })).map((c) => `${c.fan}: ${c.text}`);
  assert.notDeepEqual(await said('room_seed_one_0000000'), await said('room_seed_two_0000000'));
  assert.deepEqual(await said('room_seed_one_0000000'), await said('room_seed_one_0000000'));
});

test('the crowd keeps pace with the game: at 2x it reacts twice as fast', async () => {
  await freshStart();
  const occurred = new Map<number, number>((await app.db.query('SELECT seq, occurred_at FROM match_events WHERE match_id = $1', [shared])).rows.map((r) => [r.seq, new Date(r.occurred_at).getTime()]));
  const times = async () => new Map((await crowdLines(app.db, { roomId: pub.id, matchId: shared })).map((c) => [c.id, Date.parse(c.at)]));
  const normal = await times();
  const pace = (await app.db.query('SELECT ball_interval_ms FROM matches WHERE id = $1', [shared])).rows[0].ball_interval_ms;
  await app.db.query('UPDATE matches SET ball_interval_ms = $2 WHERE id = $1', [shared, pace / 2]);
  try {
    const fast = await times();
    assert.ok(normal.size > 0);
    for (const [id, t] of normal) {
      const ball = occurred.get(Number(id.split(':')[1]))!;
      assert.ok(Math.abs((fast.get(id)! - ball) - (t - ball) / 2) <= 1, id);
    }
  } finally {
    await app.db.query('UPDATE matches SET ball_interval_ms = $2 WHERE id = $1', [shared, pace]);
  }
});

test("lines the room's moderation would not allow are left out", async () => {
  await freshStart();
  const saved = CROWD.start;
  try {
    CROWD.start = { CSK: ['call me on 9876543210'], MI: ['call me on 9876543210'] };
    const lines = await crowdLines(app.db, { roomId: pub.id, matchId: shared, level: 'relaxed' });
    assert.ok(lines.length > 0);
    assert.ok(lines.every((c) => !c.text.includes('9876543210')));
    assert.ok(!lines.some((c) => itemOf(c) === 0)); // the opening cue had nothing allowed left to say
  } finally {
    CROWD.start = saved;
  }
});
