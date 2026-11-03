import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, signUp, makePrivateRoom, msgId, clearCooldown, logs, type App, type Client, type ApiEvent, type ApiInvitation } from './helpers.ts';
import { pump, HANDLERS } from '../lib/jobs/worker.ts';
import { purgeRoom } from '../lib/rooms/lifecycle.ts';
import { claimJobs, failJob, enqueue } from '../lib/jobs/queue.ts';
import { newId } from '../lib/util.ts';

let app: App; let owner: Client; let friend: Client; let mod: Client; let third: Client;
before(async () => {
  app = await startApp((cfg) => { cfg.cohost.unansweredDelaySeconds = 120; });
  owner = await signUp(app.base, 'life_owner');
  friend = await signUp(app.base, 'life_friend');
  third = await signUp(app.base, 'life_third');
  mod = await signUp(app.base, 'life_mod');
  app.cfg.moderatorUserIds = [mod.user.id];
  await owner.get('/api/rooms');
  await app.db.query(`UPDATE matches SET feed_started_at = now() + interval '1 hour'`);
});
after(async () => { await app.close(); });

async function say(c: Client, room: string, text: string, extra: Record<string, unknown> = {}) {
  await clearCooldown(app.db, c.user.id);
  return c.post(`/api/rooms/${room}/messages`, { client_msg_id: msgId(), text, ...extra });
}

test('ending a room cancels its queued jobs and pending invitations; the purge deletes content and is idempotent', async () => {
  const room = await makePrivateRoom(app, owner, [friend]);
  await owner.post(`/api/rooms/${room}/invitations`, { invitee_ids: [third.user.id] });
  await say(friend, room, 'What will CSK need after this over?'); // queues a delayed AI answer
  await say(owner, room, 'private chat line');
  assert.ok((await app.db.query(`SELECT count(*)::int AS n FROM jobs WHERE room_id = $1 AND status = 'queued'`, [room])).rows[0].n > 0);
  await owner.post(`/api/rooms/${room}/end`);
  assert.equal((await app.db.query(`SELECT count(*)::int AS n FROM jobs WHERE room_id = $1 AND status = 'queued'`, [room])).rows[0].n, 0);
  assert.equal((await app.db.query(`SELECT count(*)::int AS n FROM room_invitations WHERE room_id = $1 AND status = 'pending'`, [room])).rows[0].n, 0);
  const purgeJob = (await app.db.query(`SELECT run_at > now() + interval '23 hours' AS later FROM jobs WHERE dedupe_key = $1`, [`purge:${room}`])).rows[0];
  assert.equal(purgeJob.later, true); // deletion is scheduled for the retention window

  assert.equal(await purgeRoom(app.db, room), 'purged');
  assert.equal(await purgeRoom(app.db, room), 'already_purged');
  for (const table of ['messages', 'room_events', 'polls', 'room_insights', 'room_presence']) {
    assert.equal((await app.db.query(`SELECT count(*)::int AS n FROM ${table} WHERE room_id = $1`, [room])).rows[0].n, 0, table);
  }
  const r = (await app.db.query('SELECT status, name FROM rooms WHERE id = $1', [room])).rows[0];
  assert.deepEqual(r, { status: 'purged', name: null });
});

test('queued work that wakes after closure cannot republish into the room', async () => {
  const room = await makePrivateRoom(app, owner, [friend]);
  const q = await say(friend, room, 'Who is bowling?');
  await owner.post(`/api/rooms/${room}/end`);
  await app.db.query(`UPDATE jobs SET status = 'queued', run_at = now() WHERE room_id = $1`, [room]);
  await pump(app.db, { budgetMs: 3000 });
  assert.equal((await app.db.query(`SELECT count(*)::int AS n FROM messages WHERE room_id = $1 AND sender_type = 'ai'`, [room])).rows[0].n, 0);
  assert.ok(q.status === 201);
});

test('failed jobs retry with backoff and land in the dead-letter state after max attempts', async () => {
  await enqueue(app.db, { type: 'no_such_type_retry', dedupeKey: 'retry-test', maxAttempts: 2 });
  let [job] = (await claimJobs(app.db, { limit: 50 })).filter((j) => j.dedupe_key === 'retry-test');
  assert.equal(await failJob(app.db, job, { category: 'flaky' }, { random: () => 0 }), 'retry');
  const back = (await app.db.query(`SELECT status, run_at > now() AS later FROM jobs WHERE id = $1`, [job.id])).rows[0];
  assert.deepEqual(back, { status: 'queued', later: true });
  await app.db.query(`UPDATE jobs SET run_at = now() WHERE id = $1`, [job.id]);
  [job] = (await claimJobs(app.db, { limit: 50 })).filter((j) => j.dedupe_key === 'retry-test');
  assert.equal(await failJob(app.db, job, { category: 'flaky' }), 'dead');
  assert.equal((await app.db.query('SELECT status FROM jobs WHERE id = $1', [job.id])).rows[0].status, 'dead');
});

test('a big moment reaches every member still in the room, in the room only; one who left sees nothing more', async () => {
  const leaver = await signUp(app.base, 'life_leaver');
  const stayer = await signUp(app.base, 'life_stayer');
  const room = await makePrivateRoom(app, owner, [leaver, stayer]);
  await leaver.post(`/api/rooms/${room}/leave`);
  const matchId = (await app.db.query('SELECT match_id FROM rooms WHERE id = $1', [room])).rows[0].match_id;
  const ev = newId('mev');
  await app.db.query(
    `INSERT INTO match_events (id, match_id, provider_event_id, seq, kind, data, occurred_at) VALUES ($1, $2, 'life:1', 1000, 'ball', '{}'::jsonb, now())`,
    [ev, matchId]);
  const signal = newId('sig');
  await app.db.query(
    `INSERT INTO match_signals (id, match_id, event_id, trigger, priority, label, evidence, fact_text, dedupe_key, status, expires_at)
     VALUES ($1, $2, $3, 'wicket_fallen', 'high', 'Big wicket', '{}'::jsonb, 'WICKET: test fact.', $1, 'pending', now() + interval '3 minutes')`,
    [signal, matchId, ev]);
  assert.equal(await HANDLERS.momentum_signal(app.db, { payload: { signal_id: signal } }), 'published');
  const insight = (await stayer.get(`/api/rooms/${room}/events?after=0`)).body.events.find((e: ApiEvent) => e.type === 'insight');
  assert.equal(insight.data.fact, 'WICKET: test fact.');
  assert.equal((await leaver.get(`/api/rooms/${room}/events?after=0`)).status, 404);
  // No chat row, and nothing queued for anyone outside the room.
  assert.equal((await app.db.query(`SELECT count(*)::int AS n FROM messages WHERE body LIKE '%WICKET%'`)).rows[0].n, 0);
  assert.equal((await app.db.query(`SELECT count(*)::int AS n FROM jobs WHERE type LIKE 'push%'`)).rows[0].n, 0);
  await app.db.query('DELETE FROM match_events WHERE id = $1', [ev]); // not a script item: the feed must never replay it
});

test('invitations show in the app only: on the invitee\'s home list, with no notification job', async () => {
  const r = await owner.post('/api/rooms', { name: 'Late night crew', invitee_ids: [third.user.id] });
  const inv = (await third.get('/api/me/invitations')).body.invitations.find((i: ApiInvitation) => i.room_id === r.body.room_id);
  assert.equal(inv.inviter_handle, 'life_owner');
  assert.equal((await app.db.query(`SELECT count(*)::int AS n FROM jobs WHERE type LIKE 'push%'`)).rows[0].n, 0);
  assert.equal((await third.post(`/api/invitations/${inv.id}/decline`)).status, 200);
  assert.ok(!(await third.get('/api/me/invitations')).body.invitations.some((i: ApiInvitation) => i.room_id === r.body.room_id));
});

test('an auto-end queued for a game the room no longer follows leaves the room open', async () => {
  const room = await makePrivateRoom(app, owner, []);
  const old = (await app.db.query('SELECT match_id FROM rooms WHERE id = $1', [room])).rows[0].match_id;
  const other = (await app.db.query(`SELECT id FROM matches WHERE fixture_key <> 'mi-csk-demo' LIMIT 1`)).rows[0].id;
  await app.db.query('UPDATE rooms SET match_id = $2 WHERE id = $1', [room, other]); // as migration 013 moves rooms
  assert.equal(await HANDLERS.room_auto_end(app.db, { payload: { room_id: room, match_id: old } }), 'done');
  assert.equal((await app.db.query('SELECT status FROM rooms WHERE id = $1', [room])).rows[0].status, 'active');
  assert.equal(await HANDLERS.room_auto_end(app.db, { payload: { room_id: room, match_id: other } }), 'ended');
});

test('reports reach human review; three reports hide a message; moderators approve or remove; appeals are possible', async () => {
  const room = await makePrivateRoom(app, owner, [friend, third, mod]);
  const target = (await say(owner, room, 'Hardik is the worst captain ever')).body.message;
  assert.equal((await owner.post(`/api/rooms/${room}/messages/${target.id}/report`, { reason: 'harassment' })).status, 400); // own message
  for (const c of [friend, third]) assert.equal((await c.post(`/api/rooms/${room}/messages/${target.id}/report`, { reason: 'harassment' })).status, 200);
  assert.equal((await friend.post(`/api/rooms/${room}/messages/${target.id}/report`, { reason: 'harassment' })).status, 409);
  const third3 = await mod.post(`/api/rooms/${room}/messages/${target.id}/report`, { reason: 'other' });
  assert.equal(third3.body.hidden, true);
  const queue = await mod.get('/api/mod/queue');
  assert.equal(queue.status, 200);
  assert.ok(queue.body.held.some((m: { id: string }) => m.id === target.id));
  assert.equal((await friend.get('/api/mod/queue')).status, 403);
  assert.equal((await mod.post(`/api/mod/messages/${target.id}`, { action: 'approve' })).status, 200);
  const visible = (await app.db.query('SELECT status FROM messages WHERE id = $1', [target.id])).rows[0].status;
  assert.equal(visible, 'visible');

  await clearCooldown(app.db, friend.user.id);
  const rejected = await say(friend, room, 'tu chutiya hai');
  assert.equal(rejected.status, 422);
  const ap = await friend.post('/api/appeals', { moderation_event_id: rejected.body.error.moderation_event_id, note: 'It was a joke between friends' });
  assert.equal(ap.status, 200);
  assert.equal((await third.post('/api/appeals', { moderation_event_id: rejected.body.error.moderation_event_id })).status, 404);
});

test('logs never contain message bodies or session tokens', async () => {
  const room = await makePrivateRoom(app, owner, [friend]);
  await say(owner, room, 'UNIQUE-PRIVATE-CANARY-7731 nobody should log this');
  const all = logs.join('\n');
  assert.ok(!all.includes('UNIQUE-PRIVATE-CANARY-7731'));
  assert.ok(!all.includes(owner.cookie.split('=')[1]));
});
