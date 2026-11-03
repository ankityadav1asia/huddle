import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KABADDI } from '../lib/match/sports/kabaddi.ts';
import type { Signal } from '../lib/match/fixture.ts';

// The PKL game: plays out from its START state, with the scoreboard, moment cards and #threads the feed serves.
const { engine, items } = KABADDI;
function play() {
  const states = [engine.initialState(KABADDI)];
  const signals: Signal[] = [];
  items.forEach((item, seq) => {
    const prev = states[states.length - 1];
    const { state, ball } = engine.applyItem(prev, item, seq);
    signals.push(...engine.detectSignals(prev, state, item, ball, seq));
    states.push(state);
  });
  return { states, signals, final: engine.snapshot(states[states.length - 1]) };
}

test('START plus every raid reconciles: each score is its points breakdown, and the players add up', () => {
  const start = engine.snapshot(engine.initialState(KABADDI));
  assert.equal(start.clock, '13:00');
  assert.deepEqual(start.teams.map((t) => t.score), [24, 23]);
  assert.ok(items.length >= 30 && items.length <= 45, `${items.length} items`);
  const { states, final } = play();
  for (const s of states) {
    for (const code of ['JPP', 'PAT']) {
      const p = s.points[code];
      assert.equal(s.score[code], p.raid + p.tackle + p.all_out + p.extra, code);
      assert.ok(s.on_mat[code] >= 1 && s.on_mat[code] <= 7, `${code} on the mat: ${s.on_mat[code]}`);
      const players = Object.entries(s.players).filter(([name]) => KABADDI.roster.find((r) => r.name === name)?.team === (code === 'JPP' ? 'Jaipur Pink Panthers' : 'Patna Pirates'));
      assert.equal(players.reduce((n, [, x]) => n + x.raid_points, 0), p.raid, `${code} raid points`);
      assert.equal(players.reduce((n, [, x]) => n + x.tackle_points, 0), p.tackle, `${code} tackle points`);
    }
  }
  assert.deepEqual(final.teams.map(({ code, score, raid_points, tackle_points, all_out_points, extra_points }) => [code, score, raid_points, tackle_points, all_out_points, extra_points]),
    [['JPP', 44, 28, 13, 2, 1], ['PAT', 41, 26, 11, 2, 2]]);
  assert.equal(final.result, 'Jaipur win 44-41');
  assert.equal(final.do_or_die, false);
  assert.equal(final.raiders[0].name, 'Arjun Deshwal');
});

test('the game is deterministic, and the graph and play labels follow the clock', () => {
  const a = play();
  const b = play();
  assert.deepEqual(a.final, b.final);
  assert.deepEqual(a.signals, b.signals);
  const g = engine.graphs(a.states);
  assert.equal(g.kind, 'score');
  assert.deepEqual(g.kind === 'score' && [g.points[0], g.points.at(-1)], [{ label: '2H 13:00', a: 24, b: 23 }, { label: '2H 00:00', a: 44, b: 41 }]);
  assert.deepEqual(engine.describe(items[1], a.states[0], a.states[1], null), { over: '2H 12:40', symbol: null });
});

test('big-moment cards fire once each: super tackles, super raids, the all-out, the last-minute do-or-die and the result', () => {
  const { signals } = play();
  assert.deepEqual(signals.map((s) => s.trigger),
    ['super_tackle', 'super_tackle', 'super_raid', 'super_raid', 'all_out', 'do_or_die', 'late_lead', 'match_result_confirmed']);
  assert.equal(new Set(signals.map((s) => `${s.trigger}:${s.dedupe}`)).size, signals.length);
  assert.equal(signals[2].label, 'Do-or-die super raid');
  assert.ok(signals.every((s) => s.fact_text && !/simulat|demo|replay|scripted|made.?up/i.test(s.fact_text)));
});

test('the rules sheet, roster and crowd cover what the game uses', () => {
  const topics = KABADDI.rules.map((r) => r.topic);
  for (const t of ['Raid', 'Bonus point', 'Tackle', 'Super tackle', 'All out', 'Do-or-die raid', 'Revival']) assert.ok(topics.includes(t), t);
  for (const item of items) {
    if (item.crowd) assert.ok(item.crowd.key in KABADDI.crowd.lines, item.crowd.key);
    for (const name of [item.raid?.by, ...(item.raid?.touch || []), ...(item.raid?.tackled || [])].filter(Boolean)) {
      assert.ok(KABADDI.roster.some((r) => r.name === name), String(name));
    }
  }
  assert.equal(KABADDI.crowd.fans.length, 200);
  assert.ok(KABADDI.terms.test('What is a super tackle?'));
});
