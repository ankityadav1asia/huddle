import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, signUp, makePrivateRoom, type App, type ApiEvent } from './helpers.ts';
import { DEMO_FIXTURE, schedule } from '../lib/match/fixture.ts';
import { initialState, applyItem, snapshot } from '../lib/match/scorecard.ts';
import { detectSignals } from '../lib/match/momentum.ts';
import { ingestDue, ensureDemoMatch, clearMatchCache } from '../lib/match/feed.ts';
import { pump } from '../lib/jobs/worker.ts';

let app: App;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

const offsets = schedule(DEMO_FIXTURE, 10);

// Moves the feed clock so that exactly item i is due now (and fresh), then ingests.
async function ingestItem(matchId: string, i: number) {
  await app.db.query(`UPDATE matches SET status = 'live', feed_started_at = now() - $2::float8 * interval '1 second' WHERE id = $1`, [matchId, offsets[i] + 0.05]);
  return ingestDue(app.db, matchId);
}

// Plays every item before i in one late pass and silences what it raised, so item i is the next fresh moment.
async function playQuietlyBefore(matchId: string, i: number) {
  await app.db.query(`UPDATE matches SET status = 'live', feed_started_at = now() - $2::float8 * interval '1 second' WHERE id = $1`, [matchId, offsets[i - 1] + 0.05]);
  await ingestDue(app.db, matchId);
  await app.db.query(`UPDATE match_signals SET status = 'suppressed' WHERE match_id = $1 AND status = 'pending'`, [matchId]);
  await app.db.query(`DELETE FROM jobs WHERE type = 'momentum_signal'`);
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
  assert.deepEqual(snap.fall_of_wickets.slice(-2).map((w: { name: string }) => w.name), ['Shivam Dube', 'Dewald Brevis']);
});

test('batters and fallen wickets carry their fours and sixes, counted ball by ball', () => {
  let s = initialState(DEMO_FIXTURE);
  DEMO_FIXTURE.items.forEach((item, i) => { s = applyItem(s, item, i).state; });
  const snap = snapshot(s);
  const dube = snap.fall_of_wickets.find((w) => w.name === 'Shivam Dube')!;
  assert.deepEqual([dube.r, dube.b, dube.fours, dube.sixes], [65, 32, 3, 6]); // 41 (24) with 2 fours, 3 sixes when the feed starts
  const dhoni = snap.batters.find((b) => b.name === 'MS Dhoni')!;
  assert.deepEqual([dhoni.runs, dhoni.balls, dhoni.fours, dhoni.sixes], [7, 3, 0, 1]);
  const gaikwad = snap.batters.find((b) => b.name === 'Ruturaj Gaikwad')!;
  assert.equal(gaikwad.fours, 2 + 3); // three more in the feed
  for (const w of snap.fall_of_wickets) assert.ok(4 * w.fours + 6 * w.sixes <= w.r, w.name);
  // Every boundary of the feed is on someone's card.
  const feedBoundaries = (key: 'fours' | 'sixes') => [...snap.batters, ...snap.fall_of_wickets].reduce((n, x) => n + x[key], 0);
  assert.equal(feedBoundaries('fours') - (2 + 2 + 2 + 4), snap.team_stats.fours_in_feed);
  assert.equal(feedBoundaries('sixes') - (3 + 1 + 0 + 2), snap.team_stats.sixes_in_feed);
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

test('a stale backlog does not burst alerts', async () => {
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
});

test('a crucial moment creates one deduplicated insight in every active room following the match, and no chat row', async () => {
  const matchId = await freshMatch();
  const [owner, here, other] = await Promise.all(['m_owner', 'm_here', 'm_other'].map((h) => signUp(app.base, h)));
  const roomA = await makePrivateRoom(app, owner, [here]);
  const roomB = await makePrivateRoom(app, other, []);
  await app.db.query(`DELETE FROM jobs`);

  // Dube's wicket is item index 14 in the fixture: play up to it quietly, then ingest it fresh.
  const wicketIdx = DEMO_FIXTURE.items.findIndex((x) => x.wicket?.out === 'Shivam Dube');
  await playQuietlyBefore(matchId, wicketIdx);
  await ingestItem(matchId, wicketIdx);
  const signal = (await app.db.query(`SELECT * FROM match_signals WHERE match_id = $1 AND status = 'pending'`, [matchId])).rows[0];
  assert.equal(signal.trigger, 'wicket_fallen');
  assert.match(signal.fact_text, /Shivam Dube c Suryakumar b Tilak/);

  await app.db.query(`UPDATE matches SET feed_started_at = now() WHERE id = $1`, [matchId]); // hold the feed
  await pump(app.db, { budgetMs: 5000 });
  await pump(app.db, { budgetMs: 5000 });

  const insights = (await app.db.query('SELECT room_id FROM room_insights WHERE signal_id = $1 ORDER BY room_id', [signal.id])).rows.map((r) => r.room_id);
  const following = (await app.db.query(`SELECT id FROM rooms WHERE match_id = $1 AND status = 'active'`, [matchId])).rows.map((r) => r.id);
  assert.ok(following.includes(roomA) && following.includes(roomB) && following.length === 3); // + the public room
  assert.deepEqual(insights.sort(), following.sort());
  const ev = await here.get(`/api/rooms/${roomA}/events?after=0`);
  const insight = ev.body.events.find((e: ApiEvent) => e.type === 'insight');
  assert.equal(insight.data.label, 'Big wicket');
  assert.equal(insight.data.priority, 'high');

  // Re-running the job (duplicate delivery) cannot create a second insight.
  await app.db.query(`UPDATE jobs SET status = 'queued', run_at = now() WHERE type = 'momentum_signal'`);
  await app.db.query(`UPDATE match_signals SET status = 'pending' WHERE id = $1`, [signal.id]);
  await pump(app.db, { budgetMs: 5000 });
  assert.equal((await app.db.query('SELECT count(*)::int AS n FROM room_insights WHERE signal_id = $1', [signal.id])).rows[0].n, 3);
  // The alert lives in the room's feed, never as a chat row.
  assert.equal((await app.db.query(`SELECT count(*)::int AS n FROM messages WHERE body LIKE '%Dube%'`)).rows[0].n, 0);
});

test('a medium-priority moment (a dropped catch) is published to the rooms too', async () => {
  const matchId = (await app.db.query(`SELECT id FROM matches WHERE status = 'live' ORDER BY created_at DESC LIMIT 1`)).rows[0].id;
  const dropIdx = DEMO_FIXTURE.items.findIndex((x) => x.drop);
  await playQuietlyBefore(matchId, dropIdx);
  await ingestItem(matchId, dropIdx);
  await app.db.query(`UPDATE matches SET feed_started_at = now() WHERE id = $1`, [matchId]);
  await pump(app.db, { budgetMs: 5000 });
  const sig = (await app.db.query(`SELECT id, status, priority FROM match_signals WHERE match_id = $1 AND trigger = 'dropped_catch'`, [matchId])).rows[0];
  assert.deepEqual([sig.status, sig.priority], ['published', 'medium']);
  assert.equal((await app.db.query('SELECT count(*)::int AS n FROM room_insights WHERE signal_id = $1', [sig.id])).rows[0].n, 3);
});
