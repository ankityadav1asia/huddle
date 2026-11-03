import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, signUp, type App, type Client } from './helpers.ts';
import { ingestDue } from '../lib/match/feed.ts';
import { FIXTURES, schedule } from '../lib/match/fixture.ts';

// The Match Centre (GET /api/rooms/:id/match?detail=1): every play labelled, and graphs per sport.
interface Play { event_id: string; kind: string; over: string; symbol: string | null; label: string | null; text: string; occurred_at: string }
interface Over { over: number; runs: number; wickets: number; total: number }

let app: App; let fan: Client; let rooms: { id: string; sport: string; match_id: string }[];
const roomOf = (sport: string) => rooms.find((r) => r.sport === sport)!;
const fixtureOf = (sport: string) => Object.values(FIXTURES).find((f) => f.sport === sport)!;
const centre = async (sport: string) => (await fan.get(`/api/rooms/${roomOf(sport).id}/match?detail=1`)).body;
// Plays the shared game of `sport` up to fixture item `i`.
async function playTo(sport: string, i: number) {
  const offsets = schedule(fixtureOf(sport), app.cfg.match.ballSeconds);
  await app.db.query(`UPDATE matches SET status = 'live', feed_started_at = now() - $2::float8 * interval '1 second' WHERE id = $1`, [roomOf(sport).match_id, offsets[i] + 0.05]);
  await ingestDue(app.db, roomOf(sport).match_id);
}

before(async () => {
  app = await startApp();
  fan = await signUp(app.base, 'centre_fan');
  rooms = (await fan.get('/api/rooms')).body.public_rooms;
  for (const r of rooms) assert.equal((await fan.post(`/api/rooms/${r.id}/join`)).status, 200);
});
after(async () => { await app.close(); });

test('cricket mid-over: every play has its over, balls their symbol, and the over in progress is graphed', async () => {
  const items = fixtureOf('cricket').items;
  const wicket = items.findIndex((x) => x.wicket?.out === 'Shivam Dube'); // 15.5, in the 16th over
  await playTo('cricket', wicket);
  const snap = await centre('cricket');
  const plays: Play[] = snap.commentary;
  assert.equal(plays.length, wicket + 1); // every item so far, overs' ends included
  assert.deepEqual(plays.map((p) => Date.parse(p.occurred_at)), plays.map((p) => Date.parse(p.occurred_at)).sort((a, b) => b - a)); // newest first
  for (const p of plays) {
    assert.match(p.over, /^\d+\.\d$/, JSON.stringify(p));
    if (p.kind === 'ball') assert.ok(['0', '1', '2', '3', '4', '6', 'W', 'wd', 'nb'].includes(p.symbol!), JSON.stringify(p));
    else assert.equal(p.symbol, null);
  }
  assert.deepEqual([plays[0].over, plays[0].symbol], ['15.5', 'W']);
  assert.deepEqual(plays.filter((p) => p.symbol === 'wd').map((p) => p.over), ['15.3']); // a wide sits at the next legal ball
  const change = plays.find((p) => p.label === 'Bowling change')!;
  assert.equal(change.over, '15.0');
  const endOf15 = plays.find((p) => p.kind === 'overend')!;
  assert.deepEqual([endOf15.over, endOf15.label, endOf15.text], ['15.0', 'End of over', 'End of over 15: 16 runs. CSK 144/2.']);

  const { graphs, score } = snap;
  assert.equal(graphs.kind, 'cricket');
  assert.equal(graphs.target, 187);
  assert.deepEqual(graphs.overs, [{ over: 15, runs: 16, wickets: 0, total: 144 }, { over: 16, runs: 13, wickets: 1, total: 157 }]);
  assert.equal(graphs.overs.at(-1).total, score.runs);
  const dube = score.fall_of_wickets.at(-1);
  assert.deepEqual([dube.name, dube.fours, dube.sixes], ['Shivam Dube', 3, 6]);
  for (const b of score.batters) assert.ok(Number.isInteger(b.fours) && Number.isInteger(b.sixes), b.name);
});

test('cricket at the end: the overs add up to the score', async () => {
  const items = fixtureOf('cricket').items;
  await playTo('cricket', items.length - 1);
  const { graphs, score, commentary } = await centre('cricket');
  assert.equal(commentary.length, items.length);
  const overs: Over[] = graphs.overs;
  assert.deepEqual(overs.map((o) => o.over), [15, 16, 17, 18, 19, 20]);
  const start = 128; // CSK 128/2 after 14 overs, when the feed starts
  assert.equal(start + overs.reduce((n, o) => n + o.runs, 0), score.runs);
  assert.equal(2 + overs.reduce((n, o) => n + o.wickets, 0), score.wickets);
  overs.forEach((o, i) => assert.equal(o.total, (i ? overs[i - 1].total : start) + o.runs, `over ${o.over}`));
  assert.equal(overs.at(-1)!.total, score.runs);
  assert.deepEqual([score.runs, score.wickets], [189, 4]);
  assert.equal(commentary.filter((p: Play) => p.kind === 'overend').length, 5);
});

test('basketball: the score worm starts where the quarter did and ends on the final score', async () => {
  const f = fixtureOf('basketball');
  await playTo('basketball', f.items.length - 1);
  const { graphs, score, commentary } = await centre('basketball');
  assert.equal(graphs.kind, 'score');
  assert.deepEqual(graphs.teams, ['GSW', 'LAL']);
  const [first, last] = [graphs.points[0], graphs.points.at(-1)];
  assert.deepEqual(first, { label: 'Q4 6:00', a: 96, b: 98 });
  const final = Object.fromEntries(score.teams.map((t: { code: string; score: number }) => [t.code, t.score]));
  assert.deepEqual([last.a, last.b], [final.GSW, final.LAL]);
  assert.equal(score.result, 'Warriors win 116-115');
  assert.equal(new Set(graphs.points.map((p: { label: string }) => p.label)).size, graphs.points.length); // one point per moment
  for (const p of commentary as Play[]) {
    assert.match(p.over, /^Q4 \d+:\d\d$/);
    assert.equal(p.symbol, null);
  }
});

test('hockey: the same worm, ending on the final score', async () => {
  const f = fixtureOf('hockey');
  await playTo('hockey', f.items.length - 1);
  const { graphs } = await centre('hockey');
  assert.deepEqual(graphs.teams, ['EDM', 'TOR']);
  assert.deepEqual(graphs.points.map((p: { a: number; b: number }) => [p.a, p.b]), [[2, 2], [3, 2], [3, 3], [4, 3], [5, 3], [5, 3]]);
  assert.deepEqual(graphs.points.at(-1), { label: 'P3 0:00', a: 5, b: 3 });
});

test('F1: lap by lap, the gaps to the leader of the top three at the end', async () => {
  const f = fixtureOf('f1');
  await playTo('f1', f.items.length - 1);
  const { graphs, commentary } = await centre('f1');
  assert.equal(graphs.kind, 'gaps');
  assert.deepEqual(graphs.drivers, ['NOR', 'VER', 'LEC']);
  assert.deepEqual(graphs.laps.map((l: { lap: number }) => l.lap), [41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53]);
  for (const l of graphs.laps) assert.deepEqual(Object.keys(l.gaps), ['NOR', 'VER', 'LEC']);
  assert.deepEqual(graphs.laps.at(-1).gaps, { NOR: 0, VER: 1.1, LEC: 2.8 });
  assert.deepEqual(graphs.laps[0].gaps, { NOR: 1.8, VER: 0, LEC: 4.5 }); // Verstappen led then
  assert.ok((commentary as Play[]).every((p) => /^Lap \d+$/.test(p.over)));
});

test('without detail=1 the snapshot stays light: the last plays, no graphs, no replay or moments', async () => {
  const snap = (await fan.get(`/api/rooms/${roomOf('cricket').id}/match`)).body;
  assert.ok(snap.commentary.length <= 10);
  for (const key of ['graphs', 'replay', 'moments']) assert.equal(key in snap, false, key);
  assert.ok(Array.isArray(snap.crowd));
});
