// Deterministic scorecard built from stored, verified feed events. The LLM never computes or alters these numbers.
import type { BatterLine, BowlerLine, CricketItem } from './demo-script.ts';
import type { CricketFixture } from './sports/cricket.ts';

interface Partnership { runs: number; balls: number }
// A wicket on the card, with the score and over it fell at.
interface Out extends BatterLine { name: string; how: string; score: string; over: string }
// The wicket a ball took, and the stand it ended.
interface Dismissal { name: string; r: number; b: number; how: string; score: string; over: string; partnership: Partnership }
// What one delivery was, as the momentum rules read it.
export interface BallRecord {
  seq: number;
  label: string;
  symbol: string;
  runs: number;
  legal: boolean;
  boundary: boolean;
  dot: boolean;
  wicket: Dismissal | null;
  drop: { by: string } | null;
  bowler: string;
  bat: string;
  text: string;
}

export interface CricketState {
  batting: string;
  bowling: string;
  target: number;
  first_innings: string;
  runs: number;
  wkts: number;
  balls: number;
  batters: Record<string, BatterLine>;
  striker: string;
  bowler: string;
  bowlers: Record<string, BowlerLine>;
  outs: Out[];
  this_over: string[];
  over_legal: number;
  ball_log: BallRecord[]; // the last 18 deliveries
  partnership: Partnership;
  extras: number;
  fours: number;
  sixes: number;
  dots: number;
  rrr_log: (number | null)[]; // the required rate after each of the last 18 legal balls
  result: string | null;
  last_seq: number;
}

export type CricketScore = ReturnType<typeof snapshot>;

export const oversText = (balls: number) => `${Math.floor(balls / 6)}.${balls % 6}`;
export const shortName = (name: string) => name.split(' ').slice(-1)[0];

export function rates(s: CricketState) {
  const need = Math.max(0, s.target - s.runs);
  const left = Math.max(0, 120 - s.balls);
  return {
    need_runs: need,
    need_balls: left,
    crr: s.balls ? +(s.runs / (s.balls / 6)).toFixed(2) : null,
    rrr: left && need ? +(need / (left / 6)).toFixed(2) : null,
  };
}

export function initialState(fixture: CricketFixture): CricketState {
  const s = structuredClone(fixture.initial);
  return {
    batting: s.batting,
    bowling: s.bowling,
    target: s.target,
    first_innings: s.firstInnings,
    runs: s.runs,
    wkts: s.wkts,
    balls: s.balls,
    batters: Object.fromEntries(Object.entries(s.batters).map(([n, v]) => [n, { ...v }])),
    striker: s.striker,
    bowler: s.bowler,
    bowlers: Object.fromEntries(Object.entries(s.bowlers).map(([n, v]) => [n, { b: v.b, r: v.r, w: v.w }])),
    outs: s.outs.map((o) => ({ ...o })),
    this_over: [],
    over_legal: 0,
    ball_log: [],
    partnership: { ...s.partnership },
    extras: 0,
    fours: 0,
    sixes: 0,
    dots: 0,
    rrr_log: [],
    result: null,
    last_seq: -1,
  };
}

// Applies one feed item; returns a new state (inputs are not mutated) and what the item was.
export function applyItem(prev: CricketState, item: CricketItem, seq: number): { state: CricketState; ball: BallRecord | null } {
  const s = structuredClone(prev);
  s.last_seq = seq;
  if (item.kind === 'overend') {
    s.this_over = [];
    s.over_legal = 0;
    s.striker = Object.keys(s.batters).find((n) => n !== s.striker) ?? s.striker; // the batters change ends
    return { state: s, ball: null };
  }
  if (item.kind === 'event') {
    if (item.bowler) s.bowler = item.bowler;
    if (item.type === 'result') s.result = item.text;
    return { state: s, ball: null };
  }
  const legal = !item.extra;
  if (s.over_legal === 6) {
    s.this_over = [];
    s.over_legal = 0;
  }
  const label = `${Math.floor(s.balls / 6)}.${(s.balls % 6) + 1}`;
  s.runs += item.runs;
  s.partnership.runs += item.runs;
  const bowler = (s.bowlers[item.bowler] ||= { b: 0, r: 0, w: 0 });
  bowler.r += item.runs;
  const bat = (s.batters[item.bat] ||= { r: 0, b: 0, fours: 0, sixes: 0 });
  if (legal) {
    s.balls += 1;
    s.over_legal += 1;
    bowler.b += 1;
    bat.r += item.runs;
    bat.b += 1;
    s.partnership.balls += 1;
    if (item.runs === 4) {
      s.fours += 1;
      bat.fours += 1;
    }
    if (item.runs === 6) {
      s.sixes += 1;
      bat.sixes += 1;
    }
    if (item.runs === 0) s.dots += 1;
  } else {
    s.extras += item.runs;
  }
  let out: Dismissal | null = null;
  if (item.wicket) {
    s.wkts += 1;
    bowler.w += 1;
    const gone = s.batters[item.wicket.out] || { r: 0, b: 0, fours: 0, sixes: 0 };
    out = { name: item.wicket.out, r: gone.r, b: gone.b, how: item.wicket.how, score: `${s.runs}/${s.wkts}`, over: oversText(s.balls), partnership: { ...prev.partnership, runs: prev.partnership.runs + item.runs } };
    s.outs.push({ name: out.name, r: gone.r, b: gone.b, fours: gone.fours, sixes: gone.sixes, how: out.how, score: out.score, over: out.over });
    delete s.batters[item.wicket.out];
    s.batters[item.wicket.next] = { r: 0, b: 0, fours: 0, sixes: 0 };
    s.partnership = { runs: 0, balls: 0 };
  }
  const symbol = item.wicket ? 'W' : item.extra === 'wd' ? 'wd' : String(item.runs);
  s.this_over.push(symbol);
  s.bowler = item.bowler;
  // Who faces next: the new batter after a wicket, else the other batter after an odd number of runs run.
  const partner = Object.keys(s.batters).find((n) => n !== item.bat);
  s.striker = item.wicket ? item.wicket.next : legal && item.runs % 2 === 1 && partner ? partner : item.bat;
  const ball: BallRecord = { seq, label, symbol, runs: item.runs, legal, boundary: legal && (item.runs === 4 || item.runs === 6), dot: legal && item.runs === 0 && !item.wicket, wicket: out, drop: item.drop || null, bowler: item.bowler, bat: item.bat, text: item.text };
  s.ball_log.push(ball);
  if (s.ball_log.length > 18) s.ball_log.shift();
  if (legal) {
    s.rrr_log.push(rates(s).rrr);
    if (s.rrr_log.length > 18) s.rrr_log.shift();
  }
  return { state: s, ball };
}

function figures({ b, r, w }: BowlerLine) {
  const overs = b % 6 ? `${Math.floor(b / 6)}.${b % 6}` : `${b / 6}`;
  return `${overs}-0-${r}-${w}`;
}

// The client-facing scorecard. Only fields we actually have; no invented statistics.
export function snapshot(s: CricketState) {
  return {
    batting: s.batting,
    bowling: s.bowling,
    runs: s.runs,
    wickets: s.wkts,
    overs: oversText(s.balls),
    balls: s.balls,
    target: s.target,
    first_innings: s.first_innings,
    ...rates(s),
    result: s.result,
    chase_won: s.runs >= s.target,
    batters: Object.entries(s.batters).map(([name, v]) => ({
      name, short: shortName(name), runs: v.r, balls: v.b, fours: v.fours, sixes: v.sixes,
      strike_rate: v.b ? +((v.r / v.b) * 100).toFixed(1) : null, on_strike: name === s.striker,
    })),
    bowler: s.bowler ? { name: s.bowler, short: shortName(s.bowler), figures: figures(s.bowlers[s.bowler] || { b: 0, r: 0, w: 0 }), economy: s.bowlers[s.bowler]?.b ? +((s.bowlers[s.bowler].r / s.bowlers[s.bowler].b) * 6).toFixed(2) : null } : null,
    bowling_card: Object.entries(s.bowlers).filter(([, v]) => v.b).map(([name, v]) => ({ name, figures: figures(v), economy: +((v.r / v.b) * 6).toFixed(2), wickets: v.w })),
    fall_of_wickets: s.outs,
    partnership: s.partnership,
    this_over: s.this_over,
    team_stats: { fours_in_feed: s.fours, sixes_in_feed: s.sixes, dots_in_feed: s.dots, extras_in_feed: s.extras },
  };
}
