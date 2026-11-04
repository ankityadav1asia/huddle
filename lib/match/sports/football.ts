// Football: the last twenty minutes of a Kolkata derby in the Indian Super League, Mohun Bagan Super Giant v East
// Bengal FC, with real players. Goals, shots, corners, fouls and cards are applied play by play, so the scoreboard
// always matches them. Moment cards come from rules over the state (goals, red cards, penalties, the result).
import type { FactsInput, Fixture, Graphs, PollTemplate, Signal, Team } from '../fixture.ts';
import type { Priority } from '../../db/rows.ts';
import { makeFans, seeded } from '../fans.ts';
import { scriptedThread, scriptedBurst, scriptedDescribe, scriptedStory, ROLE, type ScriptedItem } from './scripted.ts';

interface Goal { team: string; scorer: string; assist: string | null; penalty: boolean }
// `second_yellow`: the yellow that turns red, so it counts as both.
interface Booking { team: string; player: string; card: 'yellow' | 'red'; second_yellow?: boolean }
interface Stats { shots: number; on_target: number; corners: number; fouls: number; yellow: number; red: number }

// The game as the script has it. Scores and stats are by team code; `minute` is the label ("72'", "90+3'").
interface FootballState {
  minute: string;
  period: 'Second half' | 'Full time';
  score: Record<string, number>;
  stats: Record<string, Stats>;
  goals: (Goal & { minute: string })[];
  cards: { team: string; player: string; minute: string; card: 'yellow' | 'red' }[];
  result: string | null;
  last_seq: number;
  last_text: string;
}

// A play or event: `min` is the minute (90 in added time) and `added` the minutes into added time. A goal is also a
// shot on target; `shot` is any other attempt, `foul` the team that fouled, `penalty_for` the team awarded a penalty.
export interface FootballItem extends ScriptedItem<FootballState> {
  min: number;
  added?: number;
  shot?: { team: string; on_target: boolean };
  corner?: string;
  foul?: string;
  card?: Booking;
  goal?: Goal;
  penalty_for?: string;
  final?: boolean;
}
type Extra = Omit<FootballItem, 'kind' | 'clock' | 'min' | 'added' | 'text' | 'type' | 'label'>;
type FootballScore = ReturnType<typeof snapshot>;

const CODES = ['MBSG', 'EBFC'];
const TEAMS: Record<string, string> = { MBSG: 'Mohun Bagan Super Giant', EBFC: 'East Bengal FC' };
const SHORT: Record<string, string> = { MBSG: 'Mohun Bagan', EBFC: 'East Bengal' };
const SIDES: Team[] = CODES.map((code) => ({ code, name: TEAMS[code], logo: `assets/${code.toLowerCase()}.png` }));
const PLAYERS: Record<string, { team: string; role: string }> = {
  'Vishal Kaith': { team: 'MBSG', role: 'goalkeeper' },
  'Subhasish Bose': { team: 'MBSG', role: 'defender (captain)' },
  'Alberto Rodríguez': { team: 'MBSG', role: 'defender' },
  'Tom Aldred': { team: 'MBSG', role: 'defender' },
  'Apuia': { team: 'MBSG', role: 'midfielder' },
  'Anirudh Thapa': { team: 'MBSG', role: 'midfielder' },
  'Sahal Abdul Samad': { team: 'MBSG', role: 'midfielder' },
  'Greg Stewart': { team: 'MBSG', role: 'attacking midfielder' },
  'Liston Colaco': { team: 'MBSG', role: 'winger' },
  'Manvir Singh': { team: 'MBSG', role: 'forward' },
  'Jamie Maclaren': { team: 'MBSG', role: 'forward' },
  'Jason Cummings': { team: 'MBSG', role: 'forward' },
  'Prabhsukhan Singh Gill': { team: 'EBFC', role: 'goalkeeper' },
  'Anwar Ali': { team: 'EBFC', role: 'defender' },
  'Hijazi Maher': { team: 'EBFC', role: 'defender' },
  'Lalchungnunga': { team: 'EBFC', role: 'defender' },
  'Mohammed Rakip': { team: 'EBFC', role: 'defender' },
  'Saul Crespo': { team: 'EBFC', role: 'midfielder' },
  'Jeakson Singh': { team: 'EBFC', role: 'midfielder' },
  'Naorem Mahesh Singh': { team: 'EBFC', role: 'winger' },
  'P.V. Vishnu': { team: 'EBFC', role: 'winger' },
  'Bipin Singh': { team: 'EBFC', role: 'winger' },
  'Hamid Ahadad': { team: 'EBFC', role: 'forward' },
};
const BACKED = ['Jason Cummings', 'Liston Colaco', 'Jamie Maclaren', 'Vishal Kaith', 'Hamid Ahadad', 'P.V. Vishnu', 'Saul Crespo', 'Prabhsukhan Singh Gill'];
const last = (name: string) => name.split(/[ .]/).filter(Boolean).slice(-1)[0];
const line = (s: FootballState) => `${SHORT.MBSG} ${s.score.MBSG}, ${SHORT.EBFC} ${s.score.EBFC}`;
const label = (min: number, added?: number) => (added ? `${min}+${added}'` : `${min}'`);
const stats = (shots: number, on_target: number, corners: number, fouls: number, yellow: number, red: number): Stats =>
  ({ shots, on_target, corners, fouls, yellow, red });

// A minute as "90+5" reads in the script: '90+5' or '72'.
const at = (m: string) => { const [min, added] = m.split('+').map(Number); return { min, added, clock: label(min, added) }; };
const P = (m: string, text: string, extra: Extra = {}): FootballItem => ({ kind: 'play', ...at(m), text, ...extra });
const E = (m: string, type: string, lbl: string, text: string, extra: Extra = {}): FootballItem => ({ kind: 'event', type, label: lbl, ...at(m), text, ...extra });
const team = (player: string) => PLAYERS[player].team;
const goal = (scorer: string, assist: string | null, penalty = false): Goal => ({ team: team(scorer), scorer, assist, penalty });
const book = (player: string, card: 'yellow' | 'red' = 'yellow', second_yellow = false): Booking => ({ team: team(player), player, card, ...(second_yellow ? { second_yellow } : {}) });
const shot = (code: string, on_target = false) => ({ team: code, on_target });

// Quiet spells between the big moments, picked once with a seeded generator so every server agrees.
const FILLER = [
  'East Bengal keep the ball in midfield, Crespo and Jeakson passing it about.',
  'Bose overlaps down the left, but Lalchungnunga reads the cross and heads it clear.',
  'A long ball from Anwar Ali drifts through to Kaith, who gathers it comfortably.',
  'Throw-in deep in East Bengal territory; Mohun Bagan keep pushing them back.',
  'Rodríguez steps out of defence and sprays a pass out to the right.',
  'Gill takes his time over a goal kick and the Mohun Bagan bench want him hurried up.',
];
const filler = (() => {
  const rand = seeded('isl-mbsg-ebfc');
  const pool = [...FILLER];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
})();
let fills = 0;
const F = (m: string): FootballItem => P(m, filler[fills++ % filler.length]);

const RED_CARD = { slug: 'red-card', about: 'Hijazi Maher is sent off for a second yellow card.', keywords: ['red card', 'red', 'second yellow', 'sent off', 'maher', 'ten men', '10 men'] };
const PENALTY = { slug: 'penalty', about: 'Mohun Bagan win a late penalty and Cummings takes it.', keywords: ['penalty', 'pen', 'spot', 'lalchungnunga', 'cummings', 'dive'] };

const SCRIPT: FootballItem[] = [
  E('70', 'start', 'Second half', 'Seventy minutes gone at the Salt Lake and the Kolkata derby is level at 1-1. Maclaren and Vishnu have scored.', { crowd: { key: 'start', n: 8, spread: 6000 }, pause: 4000 }),
  P('71', 'Colaco cuts in from the left and curls one just wide of the far post.', { shot: shot('MBSG'), crowd: { key: 'chance', n: 5, share: 0.65 } }),
  F('72'),
  P('73', 'Apuia, already booked, catches Crespo late in midfield. The referee has a word but keeps his cards away.', { foul: 'MBSG', crowd: { key: 'card', n: 4, share: 0.4 } }),
  P('74', 'Crespo whips the free kick in, Anwar Ali meets it with a firm header, straight at Vishal Kaith.', { shot: shot('EBFC', true) }),
  E('75', 'sub', 'Substitution', 'Mohun Bagan change: Manvir Singh comes on for Greg Stewart.', { crowd: { key: 'sub', n: 3, share: 0.7 } }),
  P('76', 'Manvir runs at Lalchungnunga straight away and wins a corner on the right.', { corner: 'MBSG' }),
  P('77', 'Colaco swings it in, Tom Aldred rises highest but heads over the bar.', { shot: shot('MBSG'), crowd: { key: 'chance', n: 5, share: 0.65 } }),
  F('78'),
  E('79', 'sub', 'Substitution', 'East Bengal change: Bipin Singh replaces Naorem Mahesh Singh.', { crowd: { key: 'sub', n: 3, share: 0.3 } }),
  P('80', 'Bipin breaks down the left and Anirudh Thapa pulls him back. Thapa is booked.', { foul: 'MBSG', card: book('Anirudh Thapa'), crowd: { key: 'card', n: 5, share: 0.5 } }),
  P('81', 'Vishnu skips past Bose and drills it low towards the near post. Kaith gets down well and pushes it round for a corner.', {
    shot: shot('EBFC', true), corner: 'EBFC', crowd: { key: 'kaith', n: 6, share: 0.55 },
  }),
  E('82', 'goal', 'Goal', 'GOAL! East Bengal lead! Crespo\'s corner, Hamid Ahadad climbs above Aldred and powers a header into the top corner. 2-1 to the Red and Gold!', {
    goal: goal('Hamid Ahadad', 'Saul Crespo'),
    thread: { slug: 'ahadad-header', about: 'Hamid Ahadad heads East Bengal in front from a corner.', keywords: ['ahadad', 'header', 'crespo', 'corner', 'marking'] },
    crowd: { key: 'goal_ebfc', n: 16, spread: 8000, share: 0.25 }, pause: 4000,
  }),
  P('83', 'Mohun Bagan kick off, chasing the game. The East Bengal end is still bouncing.', { crowd: { key: 'tension', n: 4 } }),
  P('84', 'Maclaren turns sharply in the box, but Anwar Ali throws himself in front of the shot.', { shot: shot('MBSG'), crowd: { key: 'chance', n: 5, share: 0.6 } }),
  E('85', 'red_card', 'Red card', 'RED CARD! Hijazi Maher, already on a yellow, drags Cummings back as he breaks clear. A second yellow, and East Bengal are down to ten.', {
    foul: 'EBFC', card: book('Hijazi Maher', 'red', true),
    thread: RED_CARD, moment: 'red-card', crowd: { key: 'red', n: 12, spread: 7000, share: 0.6 }, pause: 3000,
  }),
  P('86', 'Cummings takes the free kick himself and bends it towards the top corner. Prabhsukhan Gill flies to his left and tips it over! What a save.', {
    shot: shot('MBSG', true), corner: 'MBSG', crowd: { key: 'gill', n: 8, share: 0.4 },
  }),
  P('86', 'Colaco\'s corner is met by Lalchungnunga, who heads it away.'),
  E('87', 'sub', 'Substitution', 'East Bengal reshuffle with ten men: Mohammed Rakip on for the booked Jeakson Singh.', { crowd: { key: 'sub', n: 3, share: 0.3 } }),
  E('87', 'sub', 'Substitution', 'Mohun Bagan go for it: Sahal Abdul Samad replaces Apuia.', { crowd: { key: 'sub', n: 3, share: 0.7 } }),
  F('88'),
  E('89', 'penalty', 'Penalty', 'PENALTY! Manvir Singh dances into the box and Lalchungnunga clips his heel. The referee points to the spot, and Lalchungnunga is booked.', {
    foul: 'EBFC', card: book('Lalchungnunga'), penalty_for: 'MBSG',
    thread: PENALTY, moment: 'penalty', crowd: { key: 'penalty', n: 12, spread: 7000, share: 0.65 }, pause: 4000,
  }),
  P('89', 'Gill bounces on his line as Cummings places the ball on the spot.', { crowd: { key: 'tension', n: 8 }, pause: 3000 }),
  E('90', 'goal', 'Goal', 'GOAL! Cummings sends Gill the wrong way and rolls it into the bottom corner. 2-2!', {
    goal: goal('Jason Cummings', null, true),
    thread: PENALTY, crowd: { key: 'goal_mbsg', n: 14, spread: 8000, share: 0.75 }, pause: 4000,
  }),
  E('90', 'added_time', 'Added time', 'The fourth official\'s board goes up: six minutes of added time.', { crowd: { key: 'tension', n: 6 } }),
  P('90+1', 'East Bengal break through Vishnu, who shoots from 25 yards. Well over.', { shot: shot('EBFC') }),
  P('90+2', 'Aldred brings down Ahadad on the counter and is booked. Free kick to East Bengal, 22 yards out.', { foul: 'MBSG', card: book('Tom Aldred'), crowd: { key: 'card', n: 5, share: 0.4 } }),
  P('90+2', 'Bipin Singh curls it over the wall... Vishal Kaith, at full stretch, claws it out! A huge save.', {
    shot: shot('EBFC', true), corner: 'EBFC', crowd: { key: 'kaith', n: 10, spread: 5000, share: 0.6 },
  }),
  P('90+3', 'Rodríguez heads the corner clear and Mohun Bagan break with numbers.', { crowd: { key: 'tension', n: 6 } }),
  P('90+4', 'Saul Crespo takes Sahal down to stop the break, and Crespo is booked.', { foul: 'EBFC', card: book('Saul Crespo'), crowd: { key: 'card', n: 4, share: 0.5 } }),
  E('90+5', 'goal', 'Goal', 'GOAL! LISTON COLACO! Sahal rolls the free kick short, Colaco skips past Rakip and curls it into the far corner. Mohun Bagan lead 3-2 in the 95th minute!', {
    goal: goal('Liston Colaco', 'Sahal Abdul Samad'),
    thread: { slug: 'colaco-winner', about: 'Liston Colaco puts Mohun Bagan ahead in the 95th minute.', keywords: ['colaco', 'liston', 'winner', 'stoppage', 'added time', 'injury time', '95th'] },
    moment: 'late-winner', crowd: { key: 'winner', n: 22, spread: 9000, share: 0.8 }, pause: 5000,
  }),
  P('90+6', 'One last chance for East Bengal: Anwar Ali heads a long throw just wide.', { shot: shot('EBFC'), crowd: { key: 'tension', n: 6 } }),
  E('90+6', 'full_time', 'Full time', 'FULL TIME! Mohun Bagan Super Giant come from behind to win the Kolkata derby 3-2.', {
    final: true,
    thread: { slug: 'result', about: 'The final whistle.', keywords: ['won', 'win', 'final score', 'full time'] },
    crowd: { key: 'final', n: 12, spread: 7000 }, pause: 3000,
  }),
];

function initialState(): FootballState {
  return {
    minute: "70'", period: 'Second half', score: { MBSG: 1, EBFC: 1 },
    stats: { MBSG: stats(9, 4, 5, 8, 1, 0), EBFC: stats(7, 3, 3, 11, 2, 0) },
    goals: [
      { ...goal('Jamie Maclaren', 'Liston Colaco'), minute: "23'" },
      { ...goal('P.V. Vishnu', 'Naorem Mahesh Singh'), minute: "58'" },
    ],
    cards: [
      { team: 'MBSG', player: 'Apuia', minute: "34'", card: 'yellow' },
      { team: 'EBFC', player: 'Hijazi Maher', minute: "41'", card: 'yellow' },
      { team: 'EBFC', player: 'Jeakson Singh', minute: "63'", card: 'yellow' },
    ],
    result: null, last_seq: -1, last_text: '',
  };
}

function applyItem(prev: FootballState, item: FootballItem, seq: number) {
  const s = structuredClone(prev);
  s.last_seq = seq;
  s.last_text = item.text;
  s.minute = item.clock;
  if (item.shot) {
    s.stats[item.shot.team].shots += 1;
    if (item.shot.on_target) s.stats[item.shot.team].on_target += 1;
  }
  if (item.corner) s.stats[item.corner].corners += 1;
  if (item.foul) s.stats[item.foul].fouls += 1;
  if (item.card) {
    const { team: code, player, card, second_yellow } = item.card;
    if (card === 'yellow' || second_yellow) {
      s.stats[code].yellow += 1;
      s.cards.push({ team: code, player, minute: item.clock, card: 'yellow' });
    }
    if (card === 'red') {
      s.stats[code].red += 1;
      s.cards.push({ team: code, player, minute: item.clock, card: 'red' });
    }
  }
  if (item.goal) {
    const g = item.goal;
    s.score[g.team] += 1;
    s.stats[g.team].shots += 1;
    s.stats[g.team].on_target += 1;
    s.goals.push({ ...g, minute: item.clock });
  }
  if (item.final) {
    s.period = 'Full time';
    const [a, b] = CODES;
    const hi = Math.max(s.score[a], s.score[b]);
    const lo = Math.min(s.score[a], s.score[b]);
    s.result = hi === lo ? `Draw ${hi}-${lo}` : `${SHORT[s.score[a] > s.score[b] ? a : b]} win ${hi}-${lo}`;
  }
  return { state: s, ball: null };
}

function snapshot(s: FootballState) {
  return {
    sport: 'football', minute: s.minute, period: s.period, result: s.result,
    teams: CODES.map((code) => ({ code, name: TEAMS[code], score: s.score[code], ...s.stats[code] })),
    goals: s.goals.map((g) => ({ team: g.team, scorer: g.scorer, assist: g.assist, minute: g.minute, penalty: g.penalty })),
    cards: s.cards.map((c) => ({ ...c })),
    last_play: s.last_text,
  };
}

// Rules over the state: every goal (a late equaliser or go-ahead goal from the 85th minute instead of a plain goal),
// every red card, every penalty awarded, and the result. Dedupe keys name the goal, player or minute, so each fires once.
function detectSignals(prev: FootballState, next: FootballState, item: FootballItem): Signal[] {
  const out: Signal[] = [];
  const sig = (trigger: string, priority: Priority, lbl: string, fact_text: string, dedupe: string) =>
    out.push({ trigger, priority, label: lbl, evidence: { minute: next.minute, text: item.text, score: line(next) }, fact_text, dedupe });
  if (item.penalty_for) sig('penalty', 'medium', 'Penalty', `Penalty to ${SHORT[item.penalty_for]} in the ${next.minute}: ${line(next)}.`, `penalty-${next.minute}`);
  for (const c of next.cards.slice(prev.cards.length).filter((x) => x.card === 'red')) {
    sig('red_card', 'high', 'Red card', `${c.player} (${SHORT[c.team]}) is sent off in the ${c.minute}. ${SHORT[c.team]} are down to ${11 - next.stats[c.team].red} players.`, `red-${c.player}`);
  }
  if (next.goals.length > prev.goals.length) {
    const g = next.goals[next.goals.length - 1];
    const [a, b] = CODES;
    const before = prev.score[a] - prev.score[b];
    const after = next.score[a] - next.score[b];
    const late = item.min >= 85;
    const how = `${g.scorer}${g.penalty ? ' (penalty)' : ''} scores for ${SHORT[g.team]} in the ${g.minute}${g.assist ? `, assisted by ${g.assist}` : ''}: ${line(next)}.`;
    const n = `goal-${next.goals.length}`;
    if (late && after === 0) sig('late_equaliser', 'high', 'Late equaliser', how, n);
    else if (late && before === 0) sig('late_go_ahead', 'high', 'Late go-ahead goal', how, n);
    else sig('goal', 'high', 'Goal', how, n);
  }
  if (!prev.result && next.result) {
    const scorers = next.goals.map((g) => `${g.scorer} ${g.minute}${g.penalty ? ' (pen)' : ''}`).join(', ');
    sig('match_result_confirmed', 'high', 'Result', `Full time: ${next.result} (${line(next)}). Goals: ${scorers}.`, 'result');
  }
  return out;
}

function facts(snap: FactsInput<FootballScore>) {
  const sc = snap.score;
  const [a, b] = sc.teams;
  const name = (code: string) => (code === a.code ? a.name : b.name);
  return {
    headline: `${a.name} ${a.score}-${b.score} ${b.name} · ${sc.result || sc.minute}`,
    sport: 'football', game: snap.match.title, competition: snap.match.format, status: snap.match.status, source_note: snap.match.source_label,
    minute: sc.minute, period: sc.period, score: `${a.name} ${a.score}, ${b.name} ${b.score}`, result: sc.result,
    goals: sc.goals.map((g) => `${g.minute} ${g.scorer} (${name(g.team)})${g.penalty ? ', penalty' : ''}${g.assist ? `, assist ${g.assist}` : ''}`),
    cards: sc.cards.map((c) => `${c.minute} ${c.player} (${name(c.team)}) ${c.card} card`),
    players_on_pitch: `${a.name} ${11 - a.red}, ${b.name} ${11 - b.red}`,
    stats: sc.teams.map((t) => `${t.name}: ${t.shots} shots, ${t.on_target} on target, ${t.corners} corners, ${t.fouls} fouls, ${t.yellow} yellow cards, ${t.red} red cards`),
    last_play: sc.last_play,
  };
}

function templatePoll(s: FootballState): PollTemplate {
  if (s.result) return { question: 'Player of the match?', options: ['Liston Colaco', 'Jason Cummings', 'Hamid Ahadad'] };
  return { question: 'Who wins the derby?', options: ['Mohun Bagan', 'East Bengal', 'Draw'] };
}

// The score at the start, after each goal, and now, labelled by minute.
function graphs(states: FootballState[]): Graphs {
  const [a, b] = CODES;
  const points: { label: string; a: number; b: number }[] = [];
  states.forEach((s, i) => {
    const point = { label: s.minute, a: s.score[a], b: s.score[b] };
    const prev = points.at(-1);
    if (!prev || prev.a !== point.a || prev.b !== point.b || (i === states.length - 1 && prev.label !== point.label)) points.push(point);
  });
  return { kind: 'score', teams: CODES, points };
}

const CROWD = {
  start: {
    MBSG: ['Joy Mohun Bagan! 💚❤️', 'aaj derby amader, bas 20 minute', 'Mariners, ek goal aur', 'Salt Lake is green and maroon tonight'],
    EBFC: ['Joy East Bengal! ❤️💛', 'Red & Gold aaj chhadbe na', 'ilish ready, sirf ek goal chahiye 🐟', 'derby mein form kuch nahi hota'],
  },
  chance: {
    MBSG: ['uff Liston, aar ektu! 😩', 'so close yaar', 'pressure bana ke rakho'],
    EBFC: ['phew 😮‍💨', 'bach gaye', 'chill, wide tha'],
  },
  card: {
    MBSG: ['eta ki card holo? 😤', 'ref aaj kiske saath hai', 'careful boys, cards mat lo'],
    EBFC: ['clear booking dada', 'dhyaan se khelo boys', 'card toh banta tha'],
  },
  kaith: {
    MBSG: ['KAITH!! deewar 🧱', 'Vishal bhai saves the day 🙌', 'ki save re baba 😱'],
    EBFC: ['how did he stop that 😩', 'aar ektu niche hota toh goal', 'Kaith aaj lucky hai'],
  },
  gill: {
    MBSG: ['arre yaar, top corner tha 😩', 'Gill aaj wall bana hai', 'next one goes in, trust'],
    EBFC: ['GILL!!! 🧤🔥', 'Prabhsukhan on fire', 'ki save, uff 😮‍💨'],
  },
  sub: {
    MBSG: ['fresh legs, finally', 'all-out attack now ⚡', 'Manvir ki speed dekhna'],
    EBFC: ['Bipin on, left flank pe aag 🔥', 'good change', 'hold the shape boys'],
  },
  goal_ebfc: {
    MBSG: ['eta ki marking holo?? 😡', 'Aldred kahan tha', 'no no no 😭', 'still time, still time'],
    EBFC: ['GOOOAAALLL ❤️💛❤️💛', 'AHADAD!!! ki header re 🤯', 'Joy East Bengal!!! 🔥', 'ilish party tonight 🐟🎉', 'Salt Lake kaanp raha hai', 'derby amader!!'],
  },
  goal_mbsg: {
    MBSG: ['GOOOAAALLL 💚❤️', 'CUMMINGS FROM THE SPOT 🎯', 'Joy Mohun Bagan!!!', 'chingri malai curry ready 🦐', 'never write off the Mariners'],
    EBFC: ['soft penalty tha 😤', 'Gill guessed wrong yaar', '2-2, ab hold karo'],
  },
  red: {
    MBSG: ['RED! ten men 😈', 'second yellow, bye bye Maher 👋', 'now we push, now we push'],
    EBFC: ['ki?? second yellow for THAT? 😡', 'harsh decision dada', 'ten men, still enough. hold on Red & Gold'],
  },
  penalty: {
    MBSG: ['PENALTY!!! 🙏🙏', 'clear foul, clear pen', 'Cummings please, please'],
    EBFC: ['dive! dive! 🤦', 'eta penalty?? kono touch nei', 'Gill please save it 🙏'],
  },
  tension: {
    MBSG: ['saans roko 😬', 'one more, Mariners', 'chalo chalo chalo'],
    EBFC: ['hold on boys 🙏', 'shudhu time ta kato', 'ref, whistle bajao please'],
  },
  winner: {
    MBSG: ['LISTON COLACO!!! 🤯🤯', '95th MINUTE!!! 💚❤️💚❤️', 'Joy Mohun Bagan!!!!', 'rona aa gaya 😭', 'Kolkata is green and maroon tonight'],
    EBFC: ['NOOOO 😭', 'heartbreak 💔', 'ten men aar parlo na', 'ki kore holo eta 😩'],
  },
  final: {
    MBSG: ['derby amader 💚❤️', 'what a comeback', 'Mariners never give up 🎉'],
    EBFC: ['proud of the ten men, sach mein', 'next derby amader ❤️💛', 'that red card cost us 😤'],
  },
  chatter: {
    MBSG: ['Apuia midfield mein solid', 'Liston aaj sharp lag raha', 'Maclaren ko ball do'],
    EBFC: ['Crespo ka passing darun', 'Anwar Ali at the back 🔥', 'Vishnu ko space mil raha'],
  },
};

export const FOOTBALL: Fixture<FootballState, FootballItem, FootballScore> = {
  key: 'isl-mbsg-ebfc',
  sport: 'football',
  sportName: 'football',
  title: 'Mohun Bagan v East Bengal',
  teams: SIDES,
  format: 'ISL',
  sourceLabel: 'Minute-by-minute match feed',
  items: SCRIPT,
  engine: {
    initialState, applyItem, snapshot, facts, templatePoll, graphs,
    detectSignals: (prev, next, item) => detectSignals(prev, next, item),
    threadForItem: scriptedThread,
    describe: scriptedDescribe,
  },
  crowd: {
    lines: CROWD,
    fans: makeFans(CODES, ['mariners', 'redgold', 'derby', 'kolkata', 'saltlake', 'ilish', 'chingri', 'jmb', 'jeb', 'isl', 'bagan', 'football'], { seed: 'football' }),
    burstFor: (item, _state, rand) => scriptedBurst(item, rand, 0.4),
    fill: (text) => text,
    otherSide: (code) => (code === 'MBSG' ? 'EBFC' : 'MBSG'),
    momentCues: new Set(['goal_ebfc', 'goal_mbsg', 'red', 'penalty', 'tension', 'winner', 'final']),
  },
  topics: [
    { slug: 'refs', keywords: ['ref', 'referee', 'penalty', 'card', 'foul', 'dive', 'offside'] },
    { slug: 'derby', keywords: ['derby', 'mariners', 'red and gold', 'ilish', 'chingri', 'kolkata'] },
  ],
  terms: /\b(?:goals?|scor\w*|offside|penalt\w*|pen|spot|cards?|yellow|red|book\w*|sent off|stoppage|added time|injury time|extra time|substitut\w*|subs?|corners?|free.?kicks?|fouls?|handball|keeper|goalkeeper|sav\w*|shots?|on target|header|assist\w*|derby|isl|mariners|bagan|mohun|mbsg|east bengal|ebfc|kaith|bose|aldred|apuia|thapa|sahal|colaco|liston|manvir|maclaren|cummings|gill|anwar|maher|lalchungnunga|rakip|crespo|jeakson|vishnu|bipin|ahadad|win\w*|draw|rule\w*)\b/i,
  rules: [
    { topic: 'Match length', text: 'A match has two halves of 45 minutes. An ISL league match that is level after 90 minutes ends as a draw: no extra time and no penalty shoot-out.' },
    { topic: 'Stoppage time', text: 'The referee adds time at the end of each half for substitutions, injuries, time-wasting and other stoppages. The fourth official shows the minimum added time on a board; the referee can play longer, never shorter.' },
    { topic: 'Points', text: 'In the league a win is worth 3 points, a draw 1 point and a defeat none.' },
    { topic: 'Offside', text: 'A player is in an offside position if, when a team-mate plays the ball, they are in the opponents\' half and nearer the goal line than both the ball and the second-last opponent. Level is onside. It is only an offence if they then become involved in play, and there is no offside from a goal kick, throw-in or corner kick.' },
    { topic: 'Fouls and free kicks', text: 'A foul such as a trip, push, kick or holding gives the other team a direct free kick from where it happened. Opponents must stand at least 9.15 metres (10 yards) away.' },
    { topic: 'Penalty kick', text: 'A foul that would give a direct free kick, committed by a defender inside their own penalty area, gives a penalty kick from the penalty mark, 11 metres (12 yards) from goal. The goalkeeper must stay on the goal line between the posts until the ball is kicked.' },
    { topic: 'Yellow card', text: 'A yellow card is a caution, for things like unsporting behaviour, persistent fouling, dissent or delaying a restart. A second yellow card in the same match means a red card.' },
    { topic: 'Red card', text: 'A red card sends a player off for the rest of the match and the team cannot replace them, so it plays with one player fewer. Serious foul play, violent conduct, denying an obvious goal-scoring opportunity and a second yellow card are red-card offences. A sent-off player is also suspended for at least the next match.' },
    { topic: 'Substitutions', text: 'Each team may make up to five substitutions, in no more than three stoppages during play; changes at half-time do not count as a stoppage. A player who has been replaced cannot come back on.' },
    { topic: 'Corner kick', text: 'When the ball goes out over the goal line, off a defender, without a goal being scored, the attacking team takes a corner kick from the corner arc. A goal can be scored directly from a corner.' },
    { topic: 'Goal', text: 'A goal counts when the whole ball crosses the goal line between the posts and under the crossbar, with no offence by the scoring team.' },
  ],
  roster: Object.entries(PLAYERS).map(([name, p]) => ROLE(name, TEAMS[p.team], p.role)),
  backing: {
    teams: SIDES,
    players: BACKED.map((name) => ({ name, short: last(name), team: PLAYERS[name].team })),
  },
  nicknames: { Liston: 'Liston Colaco', Manvir: 'Manvir Singh', Bipin: 'Bipin Singh', Sahal: 'Sahal Abdul Samad', Jeakson: 'Jeakson Singh', Mahesh: 'Naorem Mahesh Singh' },
  examples: ['What is offside?', 'What happens after two yellow cards?', 'Who is Liston Colaco?'],
  story: (lastSeq) => scriptedStory(SCRIPT, lastSeq, {
    venue: 'Salt Lake Stadium, Kolkata',
    first_half: ["23' GOAL Mohun Bagan: Jamie Maclaren, assisted by Liston Colaco (1-0)", "34' Apuia (Mohun Bagan) booked", "41' Hijazi Maher (East Bengal) booked"],
    half_time: 'Mohun Bagan 1-0 East Bengal',
    second_half_to_70: ["58' GOAL East Bengal: P.V. Vishnu, assisted by Naorem Mahesh Singh (1-1)", "63' Jeakson Singh (East Bengal) booked"],
  }),
};
