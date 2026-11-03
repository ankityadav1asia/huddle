import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, signUp, makePrivateRoom } from './helpers.ts';
import { DEMO_FIXTURE, schedule } from '../lib/match/fixture.ts';
import { initialState, applyItem, snapshot } from '../lib/match/scorecard.ts';
import { detectSignals } from '../lib/match/momentum.ts';
import { ingestDue, ensureDemoMatch, clearMatchCache } from '../lib/match/feed.ts';
import { pump } from '../lib/jobs/worker.ts';
import { setPushSender } from '../lib/notify/push.ts';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

const offsets = schedule(DEMO_FIXTURE, 10);

// Moves the replay clock so that exactly item i is due now (and fresh), then ingests.
async function ingestItem(matchId, i) {
  await app.db.query(`UPDATE matches SET status = 'live', feed_started_at = now() - $2::float8 * interval '1 second' WHERE id = $1`, [matchId, offsets[i] + 0.05]);
  return ingestDue(app.db, matchId);
}

async function freshMatch() {
  await app.db.query(`UPDATE matches SET status = 'completed' WHERE status IN ('scheduled', 'live')`);
  clearMatchCache();
  return ensureDemoMatch(app.db);
}

test('the scorecard is computed deterministically from verified feed events', () => {
  let s = initialState(DEMO_FIXTURE);
  DEMO_FIXTURE.items.forEach((item, i) => { s = applyItem(s, item, i).state; });
  const snap = snapshot(s);
  assert.equal(`${snap.runs}/${snap.wickets}`, '189/4');
  assert.equal(snap.overs, '20.0');
  assert.equal(snap.chase_won, true);
  assert.equal(snap.result, 'CSK win by 6 wickets off the final ball.');
  assert.deepEqual(snap.fall_of_wickets.slice(-2).map((w) => w.name), ['Shivam Dube', 'Dewald Brevis']);
});

test('momentum rules fire on wickets, drops, pressure and the result, and stay quiet on ordinary balls', () => {
  let s = initialState(DEMO_FIXTURE);
  const fired: any[] = [];
  let quiet = 0;
  DEMO_FIXTURE.items.forEach((item, i) => {
    const { state, ball } = applyItem(s, item, i);
    const sig = detectSignals(s, state, item, ball);
    if (!sig.length && item.kind === 'ball') quiet += 1;
    fired.push(...sig.map((x) => x.trigger));
    s = state;
  });
  for (const t of ['wicket_fallen', 'dropped_catch', 'match_result_confirmed', 'boundary_burst', 'death_overs_started', 'review_outcome', 'required_run_rate_spike']) {
    assert.ok(fired.includes(t), `expected ${t}`);
  }
  assert.ok(quiet > 20, 'most deliveries produce no alert');
});

test('ingestion is idempotent and one feed serves every room following the match', async () => {
  const matchId = await freshMatch();
  for (let i = 0; i <= 3; i++) await ingestItem(matchId, i);
  await ingestDue(app.db, matchId);
  await ingestDue(app.db, matchId);
  const n = (await app.db.query('SELECT count(*)::int AS n, count(DISTINCT provider_event_id)::int AS d FROM match_events WHERE match_id = $1', [matchId])).rows[0];
  assert.equal(n.n, 4);
  assert.equal(n.d, 4);
});

test('a stale backlog does not burst alerts, and a demo jump backfills silently', async () => {
  const matchId = await freshMatch();
  // The server "slept" through 25 items: they arrive late in one pass.
  await app.db.query(`UPDATE matches SET status = 'live', feed_started_at = now() - $2::float8 * interval '1 second' WHERE id = $1`, [matchId, offsets[25] + 120]);
  await ingestDue(app.db, matchId);
  const rows = (await app.db.query(
    `SELECT s.status, s.status_reason, EXTRACT(EPOCH FROM (now() - e.occurred_at))::float8 AS age
       FROM match_signals s JOIN match_events e ON e.id = s.event_id WHERE s.match_id = $1`, [matchId])).rows;
  const pending = rows.filter((r) => r.status === 'pending');
  // At most one alert survives a backlog, and only if its own event is still fresh.
  assert.ok(pending.length <= 1);
  assert.ok(pending.every((r) => r.age <= 45));
  assert.ok(rows.filter((r) => r.status_reason === 'stale').length > 0);
  // Demo jump: everything skipped is ingested as backfill and never alerts.
  const jumped = await freshMatch();
  const { jumpToMoment } = await import('../lib/match/feed.ts');
  await jumpToMoment(app.db, jumped, 'last-over');
  const backfill = (await app.db.query(`SELECT count(*)::int AS n FROM match_events WHERE match_id = $1 AND backfilled`, [jumped])).rows[0].n;
  assert.ok(backfill > 30);
  const loud = (await app.db.query(`SELECT count(*)::int AS n FROM match_signals WHERE match_id = $1 AND status = 'pending'`, [jumped])).rows[0].n;
  assert.equal(loud, 0);
});

test('a crucial moment creates one deduplicated insight in every active room, and pushes only to opted-in away members', async () => {
  const sent: any[] = [];
  setPushSender(async (sub, payload) => { sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) }); });
  const matchId = await freshMatch();
  const [owner, here, away, quitter, optout, other] = await Promise.all(['m_owner', 'm_here', 'm_away', 'm_quit', 'm_optout', 'm_other'].map((h) => signUp(app.base, h)));
  const roomA = await makePrivateRoom(app, owner, [here, away, quitter, optout]);
  const roomB = await makePrivateRoom(app, other, []);
  for (const [i, c] of [here, away, quitter, optout].entries()) {
    await c.post('/api/me/push-subscriptions', { endpoint: `https://push.example.test/sub/${i}`, keys: { p256dh: 'p'.repeat(40), auth: 'a'.repeat(16) } });
  }
  await optout.put('/api/me/notifications', { push_momentum: false });
  await quitter.post(`/api/rooms/${roomA}/leave`);
  await here.get(`/api/rooms/${roomA}/events?after=0`); // present in the room right now
  await app.db.query(`DELETE FROM jobs`);

  // Dube's wicket is item index 14 in the fixture; replay up to it, then ingest it fresh.
  const wicketIdx = DEMO_FIXTURE.items.findIndex((x) => x.wicket?.out === 'Shivam Dube');
  await app.db.query(`UPDATE matches SET status = 'live', backfill_until = $2, feed_started_at = now() - $3::float8 * interval '1 second' WHERE id = $1`, [matchId, wicketIdx - 1, offsets[wicketIdx - 1] + 0.05]);
  await ingestDue(app.db, matchId);
  await ingestItem(matchId, wicketIdx);
  const signal = (await app.db.query(`SELECT * FROM match_signals WHERE match_id = $1 AND status = 'pending'`, [matchId])).rows[0];
  assert.equal(signal.trigger, 'wicket_fallen');
  assert.match(signal.fact_text, /Shivam Dube c Suryakumar b Tilak/);

  await app.db.query(`UPDATE matches SET feed_started_at = now() WHERE id = $1`, [matchId]); // pause the feed
  await pump(app.db, { budgetMs: 5000 });
  await pump(app.db, { budgetMs: 5000 });

  const insights = (await app.db.query('SELECT room_id FROM room_insights WHERE signal_id = $1 ORDER BY room_id', [signal.id])).rows.map((r) => r.room_id);
  const following = (await app.db.query(`SELECT id FROM rooms WHERE match_id = $1 AND status = 'active'`, [matchId])).rows.map((r) => r.id);
  assert.ok(following.includes(roomA) && following.includes(roomB) && following.length === 3); // + the public room
  assert.deepEqual(insights.sort(), following.sort());
  const ev = await here.get(`/api/rooms/${roomA}/events?after=0`);
  const insight = ev.body.events.find((e) => e.type === 'insight');
  assert.equal(insight.data.label, 'Big wicket');
  assert.equal(insight.data.priority, 'high');

  // Re-running the job (duplicate delivery) cannot create a second insight or a second push.
  await app.db.query(`UPDATE jobs SET status = 'queued', run_at = now() WHERE type = 'momentum_signal'`);
  await app.db.query(`UPDATE match_signals SET status = 'pending' WHERE id = $1`, [signal.id]);
  await pump(app.db, { budgetMs: 5000 });
  assert.equal((await app.db.query('SELECT count(*)::int AS n FROM room_insights WHERE signal_id = $1', [signal.id])).rows[0].n, 3);

  const endpoints = sent.map((s) => s.endpoint);
  assert.deepEqual(endpoints, ['https://push.example.test/sub/1']); // only the away, opted-in member
  assert.match(sent[0].payload.body, /Shivam Dube c Suryakumar b Tilak/);
  assert.match(sent[0].payload.title, /Big wicket/);
  assert.ok(!sent[0].payload.body.includes('Friends room'), 'no private room name on the lock screen');
  // Delivery metadata only, never a chat row.
  const chatRows = (await app.db.query(`SELECT count(*)::int AS n FROM messages WHERE body LIKE '%WICKET%'`)).rows[0].n;
  assert.equal(chatRows, 0);
});

test('a routine low-priority moment is shown in-app but never pushed', async () => {
  const sent: any[] = [];
  setPushSender(async (sub) => { sent.push(sub.endpoint); });
  const matchId = (await app.db.query(`SELECT id FROM matches WHERE status = 'live' ORDER BY created_at DESC LIMIT 1`)).rows[0].id;
  const burstIdx = DEMO_FIXTURE.items.findIndex((x, i) => i > 15 && x.drop); // dropped catch: medium
  await app.db.query(`UPDATE matches SET backfill_until = $2, feed_started_at = now() - $3::float8 * interval '1 second' WHERE id = $1`, [matchId, burstIdx - 1, offsets[burstIdx - 1] + 0.05]);
  await ingestDue(app.db, matchId);
  await ingestItem(matchId, burstIdx);
  await app.db.query(`UPDATE matches SET feed_started_at = now() WHERE id = $1`, [matchId]);
  await pump(app.db, { budgetMs: 5000 });
  const sig = (await app.db.query(`SELECT trigger, status, priority FROM match_signals WHERE match_id = $1 ORDER BY created_at DESC LIMIT 1`, [matchId])).rows[0];
  assert.equal(sig.trigger, 'dropped_catch');
  assert.equal(sig.status, 'published');
  assert.equal(sent.length, 0);
});
