import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FOOTBALL } from '../lib/match/sports/football.ts';
import type { Signal } from '../lib/match/fixture.ts';

// The ISL derby: plays out from its START state, with the scoreboard, moment cards and #threads the feed serves.
const { engine, items } = FOOTBALL;
function play() {
  const states = [engine.initialState(FOOTBALL)];
  const signals: Signal[] = [];
  items.forEach((item, seq) => {
    const prev = states[states.length - 1];
    const { state, ball } = engine.applyItem(prev, item, seq);
    signals.push(...engine.detectSignals(prev, state, item, ball, seq));
    states.push(state);
  });
  return { states, signals, final: engine.snapshot(states[states.length - 1]) };
}

test('START plus every item reconciles with the final score and stats', () => {
  const start = engine.snapshot(engine.initialState(FOOTBALL));
  assert.equal(start.minute, "70'");
  assert.deepEqual(start.teams.map((t) => t.score), [1, 1]);
  assert.ok(items.length >= 30 && items.length <= 45, `${items.length} items`);
  const { final } = play();
  for (const [i, t] of final.teams.entries()) {
    const s = start.teams[i];
    const mine = (pick: (x: typeof items[number]) => boolean) => items.filter(pick).length;
    const goals = mine((x) => x.goal?.team === t.code);
    assert.equal(t.score, s.score + goals, t.code);
    assert.equal(t.shots, s.shots + goals + mine((x) => x.shot?.team === t.code), t.code);
    assert.equal(t.on_target, s.on_target + goals + mine((x) => x.shot?.team === t.code && x.shot.on_target), t.code);
    assert.equal(t.corners, s.corners + mine((x) => x.corner === t.code), t.code);
    assert.equal(t.fouls, s.fouls + mine((x) => x.foul === t.code), t.code);
    assert.equal(t.score, final.goals.filter((g) => g.team === t.code).length, t.code);
    assert.equal(t.yellow, final.cards.filter((c) => c.team === t.code && c.card === 'yellow').length, t.code);
    assert.equal(t.red, final.cards.filter((c) => c.team === t.code && c.card === 'red').length, t.code);
  }
  assert.deepEqual(final.teams.map(({ code, score, shots, on_target, corners, fouls, yellow, red }) => [code, score, shots, on_target, corners, fouls, yellow, red]),
    [['MBSG', 3, 15, 7, 7, 11, 3, 0], ['EBFC', 2, 13, 7, 5, 14, 5, 1]]);
  assert.equal(final.result, 'Mohun Bagan win 3-2');
  assert.equal(final.period, 'Full time');
  assert.equal(final.minute, "90+6'");
  assert.deepEqual(final.goals.map((g) => `${g.minute} ${g.scorer}${g.penalty ? ' (pen)' : ''}`),
    ["23' Jamie Maclaren", "58' P.V. Vishnu", "82' Hamid Ahadad", "90' Jason Cummings (pen)", "90+5' Liston Colaco"]);
});

test('the game is deterministic, and the graph follows the score', () => {
  const a = play();
  const b = play();
  assert.deepEqual(a.final, b.final);
  assert.deepEqual(a.signals, b.signals);
  assert.deepEqual(engine.graphs(a.states), engine.graphs(b.states));
  assert.deepEqual(engine.graphs(a.states), {
    kind: 'score', teams: ['MBSG', 'EBFC'],
    points: [{ label: "70'", a: 1, b: 1 }, { label: "82'", a: 1, b: 2 }, { label: "90'", a: 2, b: 2 }, { label: "90+5'", a: 3, b: 2 }, { label: "90+6'", a: 3, b: 2 }],
  });
  const first = a.states[0];
  assert.deepEqual(engine.describe(items[1], first, a.states[1], null), { over: "71'", symbol: null });
});

test('the snapshot has the shape the Match Centre reads', () => {
  const snap = play().final;
  assert.deepEqual(Object.keys(snap), ['sport', 'minute', 'period', 'result', 'teams', 'goals', 'cards', 'last_play']);
  assert.equal(snap.sport, 'football');
  for (const t of snap.teams) assert.deepEqual(Object.keys(t), ['code', 'name', 'score', 'shots', 'on_target', 'corners', 'fouls', 'yellow', 'red']);
  assert.deepEqual(snap.teams.map((t) => [t.code, t.name]), [['MBSG', 'Mohun Bagan Super Giant'], ['EBFC', 'East Bengal FC']]);
  for (const g of snap.goals) assert.deepEqual(Object.keys(g), ['team', 'scorer', 'assist', 'minute', 'penalty']);
  for (const c of snap.cards) assert.deepEqual(Object.keys(c), ['team', 'player', 'minute', 'card']);
  const facts = engine.facts({ match: { title: FOOTBALL.title, format: FOOTBALL.format, status: 'completed', source: 'feed', source_label: FOOTBALL.sourceLabel }, score: snap });
  assert.equal(facts.headline, 'Mohun Bagan Super Giant 3-2 East Bengal FC · Mohun Bagan win 3-2');
});

test('each moment card fires once, and the big moments open #threads with crowd lines', () => {
  const { signals } = play();
  assert.deepEqual(signals.map((s) => [s.trigger, s.label]), [
    ['goal', 'Goal'], ['red_card', 'Red card'], ['penalty', 'Penalty'], ['late_equaliser', 'Late equaliser'],
    ['late_go_ahead', 'Late go-ahead goal'], ['match_result_confirmed', 'Result'],
  ]);
  assert.equal(new Set(signals.map((s) => `${s.trigger}:${s.dedupe}`)).size, signals.length);
  assert.match(signals[1].fact_text, /Hijazi Maher \(East Bengal\) is sent off in the 85'/);
  const threads = new Set(items.map((x) => engine.threadForItem(x)?.slug).filter(Boolean));
  assert.ok(threads.has('result') && threads.size >= 4, [...threads].join());
  for (const m of ['red-card', 'penalty', 'late-winner']) assert.ok(engine.threadForItem(items.find((x) => x.moment === m)!), m);
  for (const x of items) if (x.crowd) assert.ok(FOOTBALL.crowd.lines[x.crowd.key], x.crowd.key);
  const words = /simulated|demo|replay|made-up/i;
  assert.ok(!items.some((x) => words.test(x.text)) && !words.test(JSON.stringify(FOOTBALL.crowd.lines)));
});
