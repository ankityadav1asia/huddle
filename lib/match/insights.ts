// The Match Centre's Stats tab and win predictor (GET /api/rooms/:id/match?detail=1). centre.ts replays the run's
// verified plays through the sport's engine; everything here is read off those states, or counted from how one state
// (or one play's outcome) became the next. The win chances are fixed formulas over the score and the time left, each
// spelled out in its `method`: no AI and no outside data.
import type { Fixture } from './fixture.ts';
import { rates, oversText, shortName, snapshot, type CricketState } from './scorecard.ts';

interface CompareRow { label: string; a: number; b: number; unit?: '%' }
interface ListRow { label: string; value: string; note?: string }
type Teams = [string, string];
export type Section =
  | { title: string; kind: 'compare'; teams: Teams; rows: CompareRow[] }
  | { title: string; kind: 'list'; rows: ListRow[] };
// Win chances in whole %, a for teams[0] and b for teams[1]; draw where the sport has one. a + b + draw = 100.
interface Chance { a: number; b: number; draw?: number }
interface Projection { label: string; value: string }
export interface Prediction {
  teams: Teams;
  points: (Chance & { label: string })[]; // the start of the run, then after each play
  now: Chance;
  projections: Projection[];
  method: string;
}

interface Sport<S> {
  label(s: S): string; // the start of the run, the way describe() labels a play
  stats(states: S[], balls: unknown[], teams: Teams): Section[];
  chance(s: S, teams: Teams): Chance;
  projections?(s: S): Projection[];
  method: string;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const twoWay = (pa: number): Chance => { const a = Math.round(pa * 100); return { a, b: 100 - a }; };
// Largest remainder, so the three whole numbers add up to 100.
function threeWay(pa: number, pd: number, pb: number): Chance {
  const raw = [pa, pd, pb].map((p) => p * 100);
  const out = raw.map(Math.floor);
  let left = 100 - out.reduce((n, x) => n + x, 0);
  for (const i of [0, 1, 2].sort((x, y) => (raw[y] - out[y]) - (raw[x] - out[x]))) if (left-- > 0) out[i] += 1;
  return { a: out[0], b: out[2], draw: out[1] };
}
// A result: the winner 100, or a draw 100.
const settled = (x: number, y: number, draws: boolean): Chance =>
  x === y ? { a: 0, b: 0, draw: 100 } : { a: x > y ? 100 : 0, b: x > y ? 0 : 100, ...(draws ? { draw: 0 } : {}) };
const compare = (title: string, teams: Teams, rows: CompareRow[]): Section => ({ title, kind: 'compare', teams, rows });
const list = (title: string, rows: ListRow[]): Section => ({ title, kind: 'list', rows });
const row = (label: string, value: string, note?: string): ListRow => (note ? { label, value, note } : { label, value });
const clockSeconds = (clock: string) => { const [m, s] = clock.split(':').map(Number); return m * 60 + s; };

// Cricket: the chase, ball by ball from the start of the feed (after 14 overs); the card before it comes with the
// fixture (batters' and bowlers' figures, the wickets that fell).
const ordinal = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] || 'th'}`;
const pair = (s: CricketState) => Object.keys(s.batters).map(shortName).join(' & ');

// Par from here: a T20 side scores about 9 an over across a whole innings, rising towards 11.5 at the death, scaled
// down as wickets go (by wickets in hand).
const WICKET_SCALE = [0, 0.3, 0.5, 0.66, 0.76, 0.84, 0.9, 0.94, 0.97, 0.985, 1];
const parFromHere = (left: number, inHand: number) => (left / 6) * (9 + 2.5 * (1 - left / 120) ** 1.5) * WICKET_SCALE[Math.max(0, Math.min(10, inHand))];

// The chasing side's chance: par from here against the runs needed, less uncertain as the balls run out (Dream AI's
// record of the match uses it too).
export function chaseChance(s: Pick<CricketState, 'target' | 'runs' | 'balls' | 'wkts'>): number {
  const need = s.target - s.runs;
  const left = Math.max(0, 120 - s.balls);
  const inHand = 10 - s.wkts;
  if (need <= 0) return 1;
  if (inHand <= 0 || left === 0) return 0;
  return sigmoid((1.7 * (parFromHere(left, inHand) - need)) / (4 + 14 * Math.sqrt(left / 120)));
}

function cricketStats(states: CricketState[]): Section[] {
  const [first, s] = [states[0], states[states.length - 1]];
  const r = rates(s);
  const card = [...Object.values(s.batters), ...s.outs];
  const fours = card.reduce((n, b) => n + b.fours, 0);
  const sixes = card.reduce((n, b) => n + b.sixes, 0);
  const inBoundaries = 4 * fours + 6 * sixes;
  const from = `from ${oversText(first.balls)} ov`;
  const innings = [
    row('Run rate', r.crr === null ? '-' : r.crr.toFixed(2), `${s.runs} in ${oversText(s.balls)} ov`),
    ...(r.rrr === null || s.result ? [] : [row('Required rate', r.rrr.toFixed(2), `${r.need_runs} off ${r.need_balls}`)]),
    row('Boundaries', `${fours} fours, ${sixes} sixes`),
    row('Dot balls', String(s.dots), from),
    row('Extras', String(s.runs - card.reduce((n, b) => n + b.r, 0))), // the runs not off the bat
    row('Boundary %', `${s.runs ? Math.round((100 * inBoundaries) / s.runs) : 0}%`, `${inBoundaries} of ${s.runs} runs in fours and sixes`),
  ];
  // Each stand that ended in the feed, then the current one (the stand at the crease when the feed began brings its
  // runs from before it).
  const stands: ListRow[] = [];
  for (let i = 1; i < states.length; i++) {
    const [prev, next] = [states[i - 1], states[i]];
    if (next.wkts === prev.wkts) continue;
    const runs = prev.partnership.runs + next.runs - prev.runs;
    const balls = prev.partnership.balls + next.balls - prev.balls;
    stands.push(row(`${ordinal(prev.wkts + 1)} wicket: ${pair(prev)}`, `${runs} (${balls})`, `ended at ${next.runs}/${next.wkts} (${oversText(next.balls)} ov)`));
  }
  if (s.wkts < 10) {
    const now = s.result || s.runs >= s.target ? 'unbroken' : 'current';
    stands.push(row(`${ordinal(s.wkts + 1)} wicket: ${pair(s)}`, `${s.partnership.runs} (${s.partnership.balls})`, now));
  }
  const bowling = snapshot(s).bowling_card.sort((x, y) => y.wickets - x.wickets || x.economy - y.economy)
    .map((b) => row(b.name, b.figures, `economy ${b.economy.toFixed(2)}`));
  return [list('This innings', innings), list('Partnerships', stands), list('Bowling', bowling)];
}

const CRICKET: Sport<CricketState> = {
  label: (s) => oversText(s.balls),
  stats: (states) => cricketStats(states),
  chance: (s, [a]) => (s.batting === a ? twoWay(chaseChance(s)) : twoWay(1 - chaseChance(s))),
  projections(s) {
    const r = rates(s);
    const inHand = 10 - s.wkts;
    if (s.result || !r.need_runs || !r.need_balls || inHand <= 0 || r.rrr === null) return [];
    const out: Projection[] = [];
    if (r.crr !== null) out.push({ label: `At the current rate (${r.crr.toFixed(2)} an over)`, value: `${s.batting} finish on ${Math.round(s.runs + (r.crr * r.need_balls) / 6)}` });
    out.push({ label: 'Needed', value: `${r.rrr.toFixed(2)} an over` });
    out.push({ label: `Par from here with ${inHand} wickets in hand`, value: `${Math.round(parFromHere(r.need_balls, inHand))} runs` });
    return out;
  },
  method: "Huddle's estimate from runs needed, balls and wickets left: par from here is about 9 an over, rising to 11.5 at the death and scaled down as wickets fall, set against the runs needed, with less spread as the balls run out.",
};

// Kabaddi: the score, points breakdown and players on the mat from the state; the raids from each raid's outcome.
interface KabaddiState {
  clock: string; // time left in the second half
  score: Record<string, number>;
  points: Record<string, { raid: number; tackle: number; all_out: number; extra: number }>;
  on_mat: Record<string, number>;
  result: string | null;
}
interface RaidOutcome { team: string; raid_points: number; tackle_points: number; super_tackle: boolean; do_or_die: boolean }

const KABADDI: Sport<KabaddiState> = {
  label: (s) => `2H ${s.clock}`,
  stats(states, balls, teams) {
    const s = states[states.length - 1];
    const [a, b] = teams;
    const by = (k: keyof KabaddiState['points'][string]) => ({ a: s.points[a][k], b: s.points[b][k] });
    const zero = () => ({ raids: 0, successful: 0, empty: 0, super_raids: 0, super_tackles: 0, do_or_die_won: 0 });
    const raids: Record<string, ReturnType<typeof zero>> = { [a]: zero(), [b]: zero() };
    for (const o of balls as (RaidOutcome | null)[]) {
      if (!o || !raids[o.team]) continue;
      const t = raids[o.team];
      t.raids += 1;
      if (o.raid_points > 0) t.successful += 1;
      if (o.raid_points >= 3) t.super_raids += 1;
      if (o.do_or_die && o.raid_points > 0) t.do_or_die_won += 1;
      if (!o.raid_points && !o.tackle_points && !o.do_or_die) t.empty += 1;
      if (o.super_tackle) raids[o.team === a ? b : a].super_tackles += 1;
    }
    const count = (label: string, k: keyof ReturnType<typeof zero>) => ({ label, a: raids[a][k], b: raids[b][k] });
    return [
      compare('Points', teams, [{ label: 'Raid points', ...by('raid') }, { label: 'Tackle points', ...by('tackle') },
        { label: 'All-out points', ...by('all_out') }, { label: 'Extra points', ...by('extra') }]),
      compare('Raids', teams, [count('Raids', 'raids'), count('Successful', 'successful'), count('Empty', 'empty'),
        count('Super raids', 'super_raids'), count('Super tackles', 'super_tackles'), count('Do-or-die raids won', 'do_or_die_won')]),
    ];
  },
  chance(s, [a, b]) {
    if (s.result) return settled(s.score[a], s.score[b], false);
    const lead = s.score[a] - s.score[b] + 0.3 * (s.on_mat[a] - s.on_mat[b]);
    return twoWay(sigmoid(lead / (1.2 * Math.sqrt(clockSeconds(s.clock) / 60 + 0.25))));
  },
  method: "Huddle's estimate from the lead, players on the mat (0.3 a player) and minutes left.",
};

// Football: the match stats and goals as the state keeps them, for the whole game.
interface FootballState {
  minute: string; // "72'", "90+3'"
  score: Record<string, number>;
  stats: Record<string, { shots: number; on_target: number; corners: number; fouls: number; yellow: number; red: number }>;
  goals: { team: string; scorer: string; assist: string | null; penalty: boolean; minute: string }[];
  result: string | null;
}
const poisson = (k: number, l: number) => { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; };

const FOOTBALL: Sport<FootballState> = {
  label: (s) => s.minute,
  stats(states, _balls, teams) {
    const s = states[states.length - 1];
    const [a, b] = teams;
    const by = (label: string, k: keyof FootballState['stats'][string]) => ({ label, a: s.stats[a][k], b: s.stats[b][k] });
    return [
      compare('Match stats', teams, [{ label: 'Goals', a: s.score[a], b: s.score[b] }, by('Shots', 'shots'), by('On target', 'on_target'),
        by('Corners', 'corners'), by('Fouls', 'fouls'), by('Yellow cards', 'yellow'), by('Red cards', 'red')]),
      list('Goals', s.goals.map((g) => row(g.minute, `${g.scorer} (${g.team})`, g.penalty ? 'penalty' : g.assist ? `assist: ${g.assist}` : undefined))),
    ];
  },
  chance(s, [a, b]) {
    if (s.result) return settled(s.score[a], s.score[b], true);
    const [min, added = 0] = s.minute.replace(/'/g, '').split('+').map(Number);
    const left = Math.max(1, 90 - min - added);
    const xg = (own: string, opp: string) => (left / 90) * 1.35 * 0.8 ** s.stats[own].red * 1.1 ** s.stats[opp].red;
    const [la, lb] = [xg(a, b), xg(b, a)];
    let [pa, pd, pb] = [0, 0, 0];
    for (let i = 0; i <= 8; i++) {
      for (let j = 0; j <= 8; j++) {
        const p = poisson(i, la) * poisson(j, lb);
        const d = s.score[a] + i - (s.score[b] + j);
        if (d > 0) pa += p; else if (d < 0) pb += p; else pd += p;
      }
    }
    const total = pa + pd + pb;
    return threeWay(pa / total, pd / total, pb / total);
  },
  method: "Huddle's estimate from the score, minutes left (at least one until full time) and red cards, with each side's goals for the rest a Poisson count at 1.35 per 90 minutes.",
};

// Basketball: the score, team fouls and the named players' points, from the state.
interface BasketballState {
  period: string; // "Q4"
  clock: string; // "2:31", left in the quarter
  score: Record<string, number>;
  fouls: Record<string, number>;
  players: Record<string, { team: string; pts: number }>;
  result: string | null;
}

const BASKETBALL: Sport<BasketballState> = {
  label: (s) => `${s.period} ${s.clock}`,
  stats(states, _balls, teams) {
    const s = states[states.length - 1];
    const [a, b] = teams;
    const leaders = Object.entries(s.players).sort((x, y) => y[1].pts - x[1].pts).map(([name, p]) => row(name, `${p.pts} pts`, p.team));
    return [
      compare('Team', teams, [{ label: 'Points', a: s.score[a], b: s.score[b] }, { label: 'Team fouls this quarter', a: s.fouls[a], b: s.fouls[b] }]),
      list('Leaders', leaders),
    ];
  },
  chance(s, [a, b]) {
    if (s.result) return settled(s.score[a], s.score[b], false);
    const quarter = Number(s.period.replace(/\D/g, '')) || 4;
    const left = Math.max(0, 4 - quarter) * 720 + clockSeconds(s.clock);
    return twoWay(sigmoid((1.7 * (s.score[a] - s.score[b])) / (11 * Math.sqrt(left / 2880) + 0.5)));
  },
  method: "Huddle's estimate from the lead and the time left in the game (a lead counts for more as the clock runs down).",
};

const SPORTS: Record<string, Sport<any>> = { cricket: CRICKET, kabaddi: KABADDI, football: FOOTBALL, basketball: BASKETBALL };

// states: the game at the start of the run, then after each play; overs[i] and balls[i]: play i's label (describe's
// over or clock) and what the engine said it was.
export function matchInsights(fixture: Fixture, states: unknown[], overs: string[], balls: unknown[]) {
  const sport = SPORTS[fixture.sport];
  if (!sport) return { stats: { sections: [] as Section[] }, prediction: null };
  const teams = fixture.teams.map((t) => t.code) as Teams;
  const chances = states.map((s) => sport.chance(s, teams));
  const points = chances.map((c, i) => ({ label: i ? overs[i - 1] : sport.label(states[0]), ...c }));
  const last = states[states.length - 1];
  const prediction: Prediction = { teams, points, now: chances[chances.length - 1], projections: sport.projections?.(last) || [], method: sport.method };
  return { stats: { sections: sport.stats(states, balls, teams) }, prediction };
}
