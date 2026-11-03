import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, signUp, type App, type Client } from './helpers.ts';
import { ingestDue } from '../lib/match/feed.ts';
import { FIXTURES, schedule } from '../lib/match/fixture.ts';

// The Match Centre (GET /api/rooms/:id/match?detail=1): every play labelled, graphs, stats and the win predictor per sport.
interface Play { event_id: string; kind: string; over: string; symbol: string | null; label: string | null; text: string; occurred_at: string }
interface Over { over: number; runs: number; wickets: number; total: number }
interface Point { label: string; a: number; b: number; draw?: number }
interface Row { label: string; value?: string; note?: string; a?: number; b?: number }
interface Section { title: string; kind: 'compare' | 'list'; teams?: string[]; rows: Row[] }

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

test('cricket mid-chase: the predictor has a point per play, projections from the scorecard, and stats from the card', async () => {
  const { prediction, score, stats, commentary } = await centre('cricket'); // CSK 157/3 after Dube's wicket at 15.5
  const points: Point[] = prediction.points;
  assert.equal(points.length, commentary.length + 1);
  assert.equal(points[0].label, '14.0'); // the start of the feed
  const { label: _, ...now } = points.at(-1)!;
  assert.deepEqual(prediction.now, now);
  assert.deepEqual(prediction.projections, [
    { label: `At the current rate (${score.crr.toFixed(2)} an over)`, value: `CSK finish on ${Math.round(score.runs + (score.crr * score.need_balls) / 6)}` },
    { label: 'Needed', value: `${score.rrr.toFixed(2)} an over` },
    { label: 'Par from here with 7 wickets in hand', value: `${Math.round((score.need_balls / 6) * 9.5)} runs` },
  ]);
  const [innings, stands] = stats.sections as Section[];
  assert.deepEqual(innings.rows.find((r) => r.label === 'Required rate'), { label: 'Required rate', value: score.rrr.toFixed(2), note: `${score.need_runs} off ${score.need_balls}` });
  assert.deepEqual(stands.rows.map((r) => [r.label, r.value]), [['3rd wicket: Dube & Gaikwad', '29 (11)'], ['4th wicket: Gaikwad & Brevis', '0 (0)']]);
  assert.match(stands.rows[0].note!, /^from 14\.0 ov, ended at 157\/3/); // the stand began before the feed
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

test('kabaddi and football: the score worm ends on the final score, and every play sits at its clock', async () => {
  const sides: [string, string[], RegExp][] = [['kabaddi', ['JPP', 'PAT'], /^2H \d+:\d\d$/], ['football', ['MBSG', 'EBFC'], /^\d+(\+\d+)?'$/]];
  for (const [sport, teams, clock] of sides) {
    await playTo(sport, fixtureOf(sport).items.length - 1);
    const { graphs, commentary, score } = await centre(sport);
    assert.equal(graphs.kind, 'score', sport);
    assert.deepEqual(graphs.teams, teams);
    const final = Object.fromEntries(score.teams.map((t: { code: string; score: number }) => [t.code, t.score]));
    const last = graphs.points.at(-1);
    assert.deepEqual([last.a, last.b], [final[teams[0]], final[teams[1]]], sport);
    assert.ok(score.result, sport);
    for (const p of commentary as Play[]) {
      assert.match(p.over, clock, sport);
      assert.equal(p.symbol, null);
    }
  }
});

test('without detail=1 the snapshot stays light: the last plays, no graphs, no replay or moments', async () => {
  const snap = (await fan.get(`/api/rooms/${roomOf('cricket').id}/match`)).body;
  assert.ok(snap.commentary.length <= 10);
  for (const key of ['graphs', 'replay', 'moments', 'stats', 'prediction']) assert.equal(key in snap, false, key);
  assert.ok(Array.isArray(snap.crowd));
});

const SECTIONS: Record<string, string[]> = {
  cricket: ['This innings:list', 'Partnerships:list', 'Bowling:list'],
  kabaddi: ['Points:compare', 'Raids:compare'],
  football: ['Match stats:compare', 'Goals:list'],
  basketball: ['Team:compare', 'Leaders:list'],
};

test('stats and the win predictor at the end of each run: the sport\'s sections, chances adding up to 100, the winner on 100', async () => {
  for (const sport of Object.keys(SECTIONS)) {
    await playTo(sport, fixtureOf(sport).items.length - 1);
    const { stats, prediction, commentary, score, match } = await centre(sport);
    const sections: Section[] = stats.sections;
    assert.deepEqual(sections.map((s) => `${s.title}:${s.kind}`), SECTIONS[sport]);
    const teams = match.teams.map((t: { code: string }) => t.code);
    for (const s of sections) {
      assert.ok(s.rows.length, `${sport} ${s.title}`);
      if (s.kind === 'compare') assert.deepEqual(s.teams, teams);
    }
    assert.deepEqual(prediction.teams, teams);
    assert.match(prediction.method, /^Huddle's estimate from /); // the app adds "not an official prediction" itself
    const points: Point[] = prediction.points;
    assert.deepEqual(points.slice(1).map((p) => p.label), [...commentary as Play[]].reverse().map((p) => p.over), sport); // one per play
    for (const p of points) assert.equal(p.a + p.b + (p.draw ?? 0), 100, `${sport} ${JSON.stringify(p)}`);
    const final: number[] = sport === 'cricket' ? [score.chase_won ? 0 : 1, score.chase_won ? 1 : 0]
      : teams.map((code: string) => score.teams.find((t: { code: string }) => t.code === code).score);
    const winner = final[0] > final[1] ? 'a' : 'b';
    assert.equal(points.at(-1)![winner], 100, sport);
    assert.equal(prediction.now[winner], 100, sport);
    assert.deepEqual(prediction.projections, [], sport); // nothing left to project
    if (sport !== 'cricket') { // the compare rows are the scoreboard's
      const [first] = sections;
      const total = (side: 'a' | 'b') => (sport === 'kabaddi' ? first.rows.reduce((n, r) => n + r[side]!, 0) : first.rows[0][side]);
      assert.deepEqual([total('a'), total('b')], final, sport);
    }
  }
  const cricket = (await centre('cricket')).stats.sections as Section[];
  assert.deepEqual(cricket[2].rows[0], { label: 'Jasprit Bumrah', value: '4-0-23-2', note: 'economy 5.75' }); // best figures first
  const goals = (await centre('football')).stats.sections[1].rows as Row[];
  assert.deepEqual(goals.map((g) => g.label), ["23'", "58'", "82'", "90'", "90+5'"]);
});

test('cricket\'s chase predictor rises for CSK on a boundary and falls on a wicket', async () => {
  const { prediction, commentary } = await centre('cricket');
  const points: Point[] = prediction.points;
  const plays = [...commentary as Play[]].reverse();
  let checked = 0;
  plays.forEach((p, i) => {
    const [before, after] = [points[i].b, points[i + 1].b]; // CSK is teams[1]
    if (p.symbol === '4' || p.symbol === '6') assert.ok(after > before, `${p.over} ${before} -> ${after}`);
    if (p.symbol === 'W') assert.ok(after < before, `${p.over} ${before} -> ${after}`);
    if (['4', '6', 'W'].includes(p.symbol!)) checked++;
  });
  assert.equal(checked, 10); // 8 boundaries and 2 wickets in the feed
});

test('football\'s predictor has a draw share while the score is level', async () => {
  const { prediction, commentary } = await centre('football');
  const points: Point[] = prediction.points;
  const plays = [...commentary as Play[]].reverse();
  const equaliser = plays.findIndex((p) => p.text.startsWith('GOAL! Cummings')) + 1; // 2-2
  for (const p of [points[0], points[equaliser]]) { // 1-1 at the start, 2-2 after the penalty
    assert.ok(p.draw! > p.a && p.draw! > p.b, JSON.stringify(p));
  }
  assert.deepEqual(prediction.now, { a: 100, b: 0, draw: 0 }); // Mohun Bagan won
});
