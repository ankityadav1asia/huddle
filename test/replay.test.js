import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client, signUp, makePrivateRoom } from './helpers.js';
import { ensureDemoMatch, ingestDue } from '../lib/match/feed.js';
import { HANDLERS } from '../lib/jobs/worker.js';
import { queueMomentumPushes } from '../lib/notify/index.js';
import { setPushSender } from '../lib/notify/push.js';
import { newId } from '../lib/util.js';

let app; let host; let friend; let shared; let roomId;
const runOf = async (id = roomId) => (await app.db.query('SELECT match_id FROM rooms WHERE id = $1', [id])).rows[0].match_id;
const matchRow = async (id) => (await app.db.query('SELECT * FROM matches WHERE id = $1', [id])).rows[0];
const eventCount = async (id) => (await app.db.query('SELECT count(*)::int AS n FROM match_events WHERE match_id = $1', [id])).rows[0].n;
const control = (c, body, id = roomId) => c.post(`/api/rooms/${id}/replay`, body);

before(async () => {
  app = await startApp();
  host = await signUp(app.base, 'replay_host');
  friend = await signUp(app.base, 'replay_friend');
  await host.get('/api/rooms'); // creates the shared demo match and its public room
  shared = await ensureDemoMatch(app.db);
  const r = await host.post('/api/rooms', { name: 'Our replay', match_id: shared, own_replay: true, invitee_ids: [friend.user.id] });
  assert.equal(r.status, 201);
  roomId = r.body.room_id;
  const inv = (await friend.get('/api/me/invitations')).body.invitations.find((i) => i.room_id === roomId);
  assert.equal((await friend.post(`/api/invitations/${inv.id}/accept`)).status, 200);
});
after(async () => { await app.close(); });

test('a private room can run its own replay, separate from the shared one', async () => {
  const run = await runOf();
  assert.notEqual(run, shared);
  const m = await matchRow(run);
  assert.equal(m.room_id, roomId);
  assert.equal(m.status, 'scheduled'); // waits for the host to press Start
  const snap = (await host.get(`/api/rooms/${roomId}/match`)).body;
  assert.equal(snap.match.source, 'demo_fixture');
  assert.deepEqual([snap.replay.own, snap.replay.can_control, snap.replay.paused, snap.replay.speed], [true, true, false, 1]);
  assert.deepEqual(snap.replay.moments.map((x) => x.id), ['bowling-change', 'drs', 'drop', 'last-over']);
  assert.equal((await friend.get(`/api/rooms/${roomId}/match`)).body.replay.can_control, false);
  // The shared replay stays the one the public watch party and the home screen use.
  assert.equal(await ensureDemoMatch(app.db), shared);
  assert.ok((await host.get('/api/rooms')).body.matches.every((x) => x.id !== run));
  assert.equal((await host.post('/api/rooms', { name: 'No match', own_replay: true })).status, 400);
  assert.equal((await host.post('/api/rooms', { name: 'Bad flag', match_id: shared, own_replay: 'yes' })).status, 400);
  assert.equal((await host.post('/api/rooms', { name: 'Run of a run', match_id: run, own_replay: true })).status, 400);
});

test("the host starts, pauses, resumes and speeds up only this room's replay", async () => {
  const run = await runOf();
  const sharedBefore = await matchRow(shared);
  assert.equal((await control(host, { action: 'start' })).status, 200);
  assert.equal((await control(host, { action: 'start' })).body.error.code, 'replay_state');
  await app.db.query(`UPDATE matches SET feed_started_at = now() - interval '40 seconds' WHERE id = $1`, [run]);
  await ingestDue(app.db, run);
  const played = await eventCount(run);
  assert.ok(played > 0);

  assert.equal((await control(host, { action: 'pause' })).status, 200);
  await app.db.query(`UPDATE matches SET feed_started_at = feed_started_at - interval '120 seconds' WHERE id = $1`, [run]);
  assert.equal(await ingestDue(app.db, run), 0); // nothing plays while paused
  const paused = (await host.get(`/api/rooms/${roomId}/match`)).body;
  assert.equal(paused.replay.paused, true);
  assert.equal(paused.freshness.stale, false);
  assert.equal((await control(host, { action: 'pause' })).status, 409);

  assert.equal((await control(host, { action: 'resume' })).status, 200);
  assert.ok((await eventCount(run)) > played);

  assert.equal((await control(host, { action: 'speed', speed: 2 })).status, 200);
  assert.equal((await matchRow(run)).ball_interval_ms, app.cfg.match.ballSeconds * 500);
  assert.equal((await host.get(`/api/rooms/${roomId}/match`)).body.replay.speed, 2);
  assert.equal(await ingestDue(app.db, run), 0); // a new speed never skips balls
  assert.equal((await control(host, { action: 'speed', speed: 3 })).status, 400);

  const sharedAfter = await matchRow(shared);
  assert.deepEqual([sharedAfter.status, sharedAfter.ball_interval_ms, sharedAfter.paused_at], [sharedBefore.status, sharedBefore.ball_interval_ms, null]);
});

test("every member's screen follows the host: match_rev moves on pause and resume", async () => {
  const rev = async () => (await friend.get(`/api/rooms/${roomId}/events?after=0`)).body.match_rev;
  const playing = await rev();
  assert.equal((await control(host, { action: 'pause' })).status, 200);
  const paused = await rev();
  assert.notEqual(paused, playing);
  assert.equal((await control(host, { action: 'resume' })).status, 200);
  assert.notEqual(await rev(), paused);
});

test('jumping ahead fills in the skipped balls quietly; jumping back starts a fresh run', async () => {
  const run = await runOf();
  const ahead = await control(host, { action: 'jump', moment: 'last-over' });
  assert.equal(ahead.status, 200);
  assert.equal(ahead.body.jumped_to, 'Last over');
  assert.equal(await runOf(), run);
  assert.ok((await app.db.query('SELECT count(*)::int AS n FROM match_events WHERE match_id = $1 AND backfilled', [run])).rows[0].n > 0);

  const back = await control(host, { action: 'jump', moment: 'bowling-change' });
  assert.equal(back.status, 200);
  const fresh = await runOf();
  assert.notEqual(fresh, run);
  assert.equal((await matchRow(run)).status, 'completed');
  const next = await matchRow(fresh);
  assert.deepEqual([next.room_id, next.status, next.ball_interval_ms], [roomId, 'live', app.cfg.match.ballSeconds * 500]); // keeps the 2x pace
  assert.equal((await control(host, { action: 'jump', moment: 'nope' })).status, 400);
});

test('only the owner and admins control it; shared-replay and public rooms have no controls', async () => {
  assert.equal((await control(friend, { action: 'pause' })).status, 403);
  assert.equal((await control(client(app.base), { action: 'pause' })).status, 401);
  const stranger = await signUp(app.base, 'replay_stranger');
  assert.equal((await control(stranger, { action: 'pause' })).status, 404); // a private room reveals nothing
  assert.equal((await control(host, { action: 'explode' })).status, 400);
  assert.equal((await control(host, { action: 'pause', extra: 1 })).status, 400);

  const follower = await makePrivateRoom(app, host, []); // follows the shared replay
  const nc = await control(host, { action: 'pause' }, follower);
  assert.equal(nc.status, 409);
  assert.equal(nc.body.error.code, 'not_controllable');
  assert.equal((await host.get(`/api/rooms/${follower}/match`)).body.replay.can_control, false);

  const pub = (await host.get('/api/rooms')).body.public_rooms[0];
  await host.post(`/api/rooms/${pub.id}/join`);
  assert.equal((await control(host, { action: 'pause' }, pub.id)).status, 403);
  // The DEMO_CONTROLS jump for the shared replay cannot reach a private room's run either.
  assert.equal((await host.post(`/api/demo/matches/${await runOf()}/jump`, { moment: 'drop' })).status, 403);

  assert.equal((await host.put(`/api/rooms/${roomId}/members/${friend.user.id}/role`, { role: 'admin' })).status, 200);
  assert.equal((await friend.get(`/api/rooms/${roomId}/match`)).body.replay.can_control, true);
  assert.equal((await control(friend, { action: 'pause' })).status, 200);
  assert.equal((await control(friend, { action: 'resume' })).status, 200);
});

test('restarting the replay does not reset the per-match alert cap', async () => {
  await app.db.query('DELETE FROM rate_events');
  setPushSender(async () => {});
  app.cfg.notify.minGapSeconds = 0;
  await friend.post('/api/me/push-subscriptions', { endpoint: 'https://push.example.test/replay-friend', keys: { p256dh: 'p'.repeat(40), auth: 'a'.repeat(16) } });
  await app.db.query(`UPDATE room_presence SET last_seen_at = now() - interval '10 minutes' WHERE user_id = $1`, [friend.user.id]); // away
  const delivered = async () => (await app.db.query(
    `SELECT count(*)::int AS n FROM notification_deliveries WHERE recipient_id = $1 AND kind = 'momentum'`, [friend.user.id])).rows[0].n;
  const freshRun = async () => {
    assert.equal((await control(host, { action: 'restart' })).status, 200);
    const run = await runOf();
    await app.db.query(`UPDATE matches SET feed_started_at = now() - interval '20 seconds' WHERE id = $1`, [run]);
    await ingestDue(app.db, run);
    return run;
  };
  const signal = async (run, trigger = 'wicket_fallen') => {
    const ev = (await app.db.query('SELECT id FROM match_events WHERE match_id = $1 ORDER BY seq LIMIT 1', [run])).rows[0].id;
    const s = { id: newId('sig'), match_id: run, priority: 'high', trigger };
    await app.db.query(
      `INSERT INTO match_signals (id, match_id, event_id, trigger, priority, label, evidence, fact_text, dedupe_key, status, expires_at)
       VALUES ($1, $2, $3, $4, 'high', 'Big wicket', '{}'::jsonb, 'WICKET: test fact.', $5, 'published', now() + interval '3 minutes')`,
      [s.id, run, ev, trigger, `test:${s.id}`]);
    return s;
  };

  const first = await freshRun();
  for (let i = 0; i < 10; i++) await queueMomentumPushes(app.db, await signal(first));
  assert.equal(await delivered(), app.cfg.notify.maxPerMatch - 1);
  const second = await freshRun();
  await queueMomentumPushes(app.db, await signal(second));
  assert.equal(await delivered(), app.cfg.notify.maxPerMatch - 1); // the new run shares the cap
  await queueMomentumPushes(app.db, await signal(second, 'match_result_confirmed'));
  assert.equal(await delivered(), app.cfg.notify.maxPerMatch); // the last slot is still kept for the result
});

test('an auto-end queued for a finished run does not close the room after a restart', async () => {
  await app.db.query('DELETE FROM rate_events');
  const old = await runOf();
  assert.equal((await control(host, { action: 'restart' })).status, 200);
  assert.equal(await HANDLERS.room_auto_end(app.db, { payload: { room_id: roomId, match_id: old } }), 'done');
  assert.equal((await app.db.query('SELECT status FROM rooms WHERE id = $1', [roomId])).rows[0].status, 'active');
});

test('restarts are limited per hour, so big moments (and their alerts) cannot run on a loop', async () => {
  await app.db.query('DELETE FROM rate_events');
  for (let i = 0; i < 6; i++) assert.equal((await control(host, { action: 'restart' })).status, 200);
  const limited = await control(host, { action: 'restart' });
  assert.equal(limited.status, 429);
  assert.ok(limited.body.error.retry_after > 0);
  assert.equal((await control(host, { action: 'jump', moment: 'last-over' })).status, 200); // ahead: same run
  assert.equal((await control(host, { action: 'jump', moment: 'bowling-change' })).status, 429); // back: a restart too
});
