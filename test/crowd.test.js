import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, signUp } from './helpers.js';
import { ensureDemoMatch, ingestDue } from '../lib/match/feed.js';
import { crowdLines } from '../lib/match/crowd.js';
import { CROWD } from '../lib/match/demo-script.js';

let app; let host; let friend; let shared;
const runOf = async (id) => (await app.db.query('SELECT match_id FROM rooms WHERE id = $1', [id])).rows[0].match_id;
const itemOf = (line) => Number(line.id.split(':')[1]);

// A private room with its own replay, started 25 seconds ago (the first few balls and their crowd).
async function startedRoom(name, invitees = []) {
  const r = await host.post('/api/rooms', { name, match_id: shared, own_replay: true, invitee_ids: invitees.map((u) => u.user.id) });
  assert.equal(r.status, 201);
  for (const u of invitees) {
    const inv = (await u.get('/api/me/invitations')).body.invitations.find((i) => i.room_id === r.body.room_id);
    assert.equal((await u.post(`/api/invitations/${inv.id}/accept`)).status, 200);
  }
  assert.equal((await host.post(`/api/rooms/${r.body.room_id}/replay`, { action: 'start' })).status, 200);
  const run = await runOf(r.body.room_id);
  await app.db.query(`UPDATE matches SET feed_started_at = now() - interval '25 seconds' WHERE id = $1`, [run]);
  await ingestDue(app.db, run);
  return { roomId: r.body.room_id, run };
}

before(async () => {
  app = await startApp();
  host = await signUp(app.base, 'crowd_host');
  friend = await signUp(app.base, 'crowd_friend');
  await host.get('/api/rooms');
  shared = await ensureDemoMatch(app.db);
});
after(async () => { await app.close(); });

test('simulated fans are the same for everyone in a room, labelled, and never stored as chat', async () => {
  const { roomId } = await startedRoom('Crowd room', [friend]);
  const mine = (await host.get(`/api/rooms/${roomId}/match`)).body.crowd;
  assert.ok(mine.length >= 5);
  assert.deepEqual((await friend.get(`/api/rooms/${roomId}/match`)).body.crowd, mine);
  for (const c of mine) {
    assert.deepEqual(Object.keys(c).sort(), ['at', 'fan', 'id', 'team', 'text', 'thread']);
    assert.ok(['MI', 'CSK'].includes(c.team));
    assert.ok(!Number.isNaN(Date.parse(c.at)));
    assert.doesNotMatch(c.text, /\{\w+\}/); // placeholders are filled from the scorecard
  }
  assert.equal((await app.db.query('SELECT count(*)::int AS n FROM messages WHERE room_id = $1', [roomId])).rows[0].n, 0);
});

test('each room gets its own crowd, and balls skipped by a jump get none', async () => {
  const a = await startedRoom('Crowd A');
  const b = await startedRoom('Crowd B');
  const said = async (id) => (await host.get(`/api/rooms/${id}/match`)).body.crowd.map((c) => `${c.fan}: ${c.text}`);
  assert.notDeepEqual(await said(a.roomId), await said(b.roomId));
  assert.equal((await host.post(`/api/rooms/${a.roomId}/replay`, { action: 'jump', moment: 'last-over' })).status, 200);
  const skipped = new Set((await app.db.query('SELECT seq FROM match_events WHERE match_id = $1 AND backfilled', [a.run])).rows.map((r) => r.seq));
  assert.ok(skipped.size > 0);
  assert.ok((await host.get(`/api/rooms/${a.roomId}/match`)).body.crowd.every((c) => !skipped.has(itemOf(c))));
});

test('at 2x the crowd reacts twice as fast', async () => {
  const { roomId, run } = await startedRoom('Crowd speed');
  const times = async (speed) => new Map((await crowdLines(app.db, { roomId, matchId: run, speed })).map((c) => [c.id, Date.parse(c.at)]));
  const occurred = new Map((await app.db.query('SELECT seq, occurred_at FROM match_events WHERE match_id = $1', [run])).rows.map((r) => [r.seq, new Date(r.occurred_at).getTime()]));
  const normal = await times(1);
  const fast = await times(2);
  assert.ok(normal.size > 0);
  for (const [id, t] of normal) {
    const ball = occurred.get(Number(id.split(':')[1]));
    assert.ok(Math.abs((fast.get(id) - ball) - (t - ball) / 2) <= 1, id);
  }
});

test("lines the room's moderation would not allow are left out", async () => {
  const { roomId, run } = await startedRoom('Crowd filter');
  const saved = CROWD.start;
  try {
    CROWD.start = { CSK: ['call me on 9876543210'], MI: ['call me on 9876543210'] };
    const lines = await crowdLines(app.db, { roomId, matchId: run, level: 'relaxed' });
    assert.ok(lines.every((c) => !c.text.includes('9876543210')));
    assert.ok(!lines.some((c) => itemOf(c) === 0)); // the opening cue had nothing allowed left to say
  } finally {
    CROWD.start = saved;
  }
});

test('the public watch party has simulated fans too', async () => {
  const pub = (await host.get('/api/rooms')).body.public_rooms[0];
  assert.equal((await host.post(`/api/rooms/${pub.id}/join`)).status, 200);
  await app.db.query(`UPDATE matches SET feed_started_at = now() - interval '25 seconds' WHERE id = $1`, [shared]);
  await ingestDue(app.db, shared);
  assert.ok((await host.get(`/api/rooms/${pub.id}/match`)).body.crowd.length > 0);
});
