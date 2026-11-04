// Dream AI's record of the whole cricket match up to the latest ball: the toss, Mumbai's innings and the chase ball by
// ball (cricket-history.ts before the feed, then the feed's own balls), each side's card, partnerships, phases, run
// counts and milestones, the moments that mattered and how the chase's estimated chances moved. Nothing after the
// latest ball is in it, so an answer cannot give away what happens next.
import { play, MI_INNINGS, CSK_TO_FEED, MI_DID_NOT_BAT, VENUE, TOSS, type Delivery } from './cricket-history.ts';
import { applyItem, initialState, oversText, rates, type CricketState } from './scorecard.ts';
import { chaseChance } from './insights.ts';
import type { CricketFixture } from './sports/cricket.ts';

const CSK_XI = ['Sanju Samson', 'Ayush Mhatre', 'Shivam Dube', 'Ruturaj Gaikwad', 'Dewald Brevis', 'MS Dhoni', 'Jamie Overton', 'Noor Ahmad',
  'Khaleel Ahmed', 'Anshul Kamboj', 'Nathan Ellis'];

interface Bat { r: number; b: number; fours: number; sixes: number; out: string | null }
interface Bowl { balls: number; runs: number; wkts: number; dots: number; wides: number }
interface Over { over: number; bowler: string; balls: string[]; legal: number; runs: number; wkts: number; score: string; chance?: number }
// A moment worth knowing, at its over.ball.
interface Moment { at: string; text: string }

const ordinal = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] || 'th'}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const rate = (runs: number, balls: number) => (balls ? (runs / balls) * 6 : 0).toFixed(2);
const figures = (b: Bowl) => `${Math.floor(b.balls / 6)}${b.balls % 6 ? `.${b.balls % 6}` : ''}-0-${b.runs}-${b.wkts}`;
const pct = (p: number) => Math.round(p * 100);

// One innings from its deliveries: the card, overs, partnerships, phases and run counts. `chase`: the target, when
// this is the chase, so each over carries the chasing side's estimated chance at its end.
function innings(team: string, order: string[], balls: Delivery[], chase: number | null) {
  const bats = new Map<string, Bat>();
  const bowls = new Map<string, Bowl>();
  const overs: Over[] = [];
  const fow: string[] = [];
  const outs: { name: string; how: string; r: number; b: number; fours: number; sixes: number; score: string; over: string }[] = [];
  const stands: string[] = [];
  const moments: Moment[] = [];
  const counts = { dots: 0, singles: 0, twos: 0, threes: 0, fours: 0, sixes: 0, wides: 0, leg_byes: 0 };
  let runs = 0;
  let wkts = 0;
  let legal = 0;
  let stand = { runs: 0, balls: 0 };
  let pair = order.slice(0, 2);
  let next = 2;
  const batter = (name: string) => {
    let b = bats.get(name);
    if (!b) bats.set(name, (b = { r: 0, b: 0, fours: 0, sixes: 0, out: null }));
    return b;
  };
  pair.forEach(batter);
  for (const d of balls) {
    let bowl = bowls.get(d.bowler);
    if (!bowl) bowls.set(d.bowler, (bowl = { balls: 0, runs: 0, wkts: 0, dots: 0, wides: 0 }));
    let line = overs.at(-1);
    if (!line || line.over !== d.over) overs.push((line = { over: d.over, bowler: d.bowler, balls: [], legal: 0, runs: 0, wkts: 0, score: '' }));
    runs += d.runs;
    line.runs += d.runs;
    stand.runs += d.runs;
    if (d.extra !== 'lb') bowl.runs += d.runs;
    if (d.extra === 'wd') {
      counts.wides += 1;
      bowl.wides += 1;
      line.balls.push('wd');
    } else {
      legal += 1;
      line.legal += 1;
      bowl.balls += 1;
      stand.balls += 1;
      const bat = batter(d.bat);
      bat.b += 1;
      if (d.extra === 'lb') {
        counts.leg_byes += 1;
        line.balls.push('1lb');
      } else {
        bat.r += d.runs;
        if (d.runs === 0) { counts.dots += 1; bowl.dots += 1; }
        if (d.runs === 1) counts.singles += 1;
        if (d.runs === 2) counts.twos += 1;
        if (d.runs === 3) counts.threes += 1;
        if (d.runs === 4) { counts.fours += 1; bat.fours += 1; }
        if (d.runs === 6) { counts.sixes += 1; bat.sixes += 1; }
        if (bat.r >= 50 && bat.r - d.runs < 50) moments.push({ at: d.label, text: `${d.bat} reached 50 off ${bat.b} balls (${team} ${runs}/${wkts}).` });
        line.balls.push(d.wicket ? 'W' : String(d.runs));
      }
      if (d.wicket) {
        wkts += 1;
        line.wkts += 1;
        if (!d.wicket.how.startsWith('run out')) bowl.wkts += 1;
        bat.out = d.wicket.how;
        fow.push(`${runs}/${wkts} at ${d.label} ov: ${d.wicket.out} ${bat.r} (${bat.b}), ${d.wicket.how}`);
        outs.push({ name: d.wicket.out, how: d.wicket.how, r: bat.r, b: bat.b, fours: bat.fours, sixes: bat.sixes, score: `${runs}/${wkts}`, over: d.label });
        stands.push(`${ordinal(wkts)} wicket: ${stand.runs} off ${stand.balls} balls, ${pair.join(' and ')}`);
        moments.push({ at: d.label, text: `WICKET: ${d.wicket.out} ${d.wicket.how} for ${bat.r} off ${bat.b}. ${team} ${runs}/${wkts}.` });
        stand = { runs: 0, balls: 0 };
        const comer = order[next++];
        pair = [pair.find((n) => n !== d.wicket!.out)!, ...(comer ? [comer] : [])];
        if (comer) batter(comer);
      }
    }
    line.score = `${runs}/${wkts}`;
    if (chase) line.chance = chaseChance({ target: chase, runs, balls: legal, wkts });
  }
  if (legal < 120 && pair.length === 2) stands.push(`${ordinal(wkts + 1)} wicket (unbroken): ${stand.runs} off ${stand.balls} balls, ${pair.join(' and ')}`);
  const phase = (name: string, from: number, to: number) => {
    const part = overs.filter((o) => o.over >= from && o.over <= to);
    if (!part.length) return null;
    const done = part.at(-1)!.over === to && part.at(-1)!.legal === 6;
    return `${name} (overs ${from}-${to}${done ? '' : ', so far'}): ${part.reduce((n, o) => n + o.runs, 0)} runs, ${plural(part.reduce((n, o) => n + o.wkts, 0), 'wicket')}`;
  };
  return {
    runs, wkts, legal, bats, bowls, counts, overs, moments, outs,
    card: {
      score: `${team} ${runs}/${wkts} (${oversText(legal)} overs)`,
      run_rate: rate(runs, legal),
      extras: `${counts.wides + counts.leg_byes} (${plural(counts.wides, 'wide')}, ${plural(counts.leg_byes, 'leg-bye')})`,
      batting: [...bats].map(([name, b]) => `${name} ${b.r} (${b.b} balls, ${plural(b.fours, 'four')}, ${b.sixes} six${b.sixes === 1 ? '' : 'es'}, strike rate ${b.b ? ((b.r / b.b) * 100).toFixed(1) : '0'}): ${b.out ?? 'not out'}`),
      bowling: [...bowls].map(([name, b]) => `${name} ${figures(b)} (economy ${rate(b.runs, b.balls)}, ${plural(b.dots, 'dot ball')}${b.wides ? `, ${plural(b.wides, 'wide')}` : ''})`),
      fall_of_wickets: fow,
      partnerships: stands,
      phases: [phase('Powerplay', 1, 6), phase('Middle overs', 7, 15), phase('Death overs', 16, 20)].filter(Boolean),
      // Over by over: each ball (W wicket, wd wide, 1lb leg-bye), the runs and the score at its end.
      overs: overs.map((o) => `Over ${o.over}, ${o.bowler}: ${o.balls.join(' ')} = ${plural(o.runs, 'run')}${o.wkts ? `, ${plural(o.wkts, 'wicket')}` : ''}; ${team} ${o.score}`),
      run_counts: counts,
    },
  };
}

// MI's innings as the Match Centre's Scorecard tab shows an innings (the fields of scorecard.ts's snapshot it reads).
export function firstInningsCard() {
  const inn = innings('MI', MI_INNINGS.order, play(MI_INNINGS), null);
  return {
    runs: inn.runs, wickets: inn.wkts, overs: inn.legal % 6 ? oversText(inn.legal) : String(inn.legal / 6), crr: Number(rate(inn.runs, inn.legal)),
    result: 'Innings complete',
    batters: [...inn.bats].filter(([, b]) => !b.out).map(([name, b]) => ({ name, runs: b.r, balls: b.b, fours: b.fours, sixes: b.sixes, on_strike: false })),
    bowler: null,
    bowling_card: [...inn.bowls].map(([name, b]) => ({ name, figures: figures(b), economy: Number(rate(b.runs, b.balls)), wickets: b.wkts })),
    fall_of_wickets: inn.outs,
    did_not_bat: MI_DID_NOT_BAT,
  };
}

// The feed's deliveries and events up to `lastSeq`, read off the scorecard engine the live score uses.
function feed(fixture: CricketFixture, lastSeq: number) {
  let state: CricketState = initialState(fixture);
  const balls: Delivery[] = [];
  const moments: Moment[] = [];
  for (let i = 0; i <= lastSeq && i < fixture.items.length; i++) {
    const item = fixture.items[i];
    const { state: next, ball } = applyItem(state, item, i);
    if (ball) {
      balls.push({ over: Number(ball.label.split('.')[0]) + 1, label: ball.label, bowler: ball.bowler, bat: ball.bat, runs: ball.runs, extra: ball.legal ? null : 'wd', wicket: ball.wicket ? { out: ball.wicket.name, how: ball.wicket.how } : null });
      if (ball.drop || (ball.legal && ball.runs === 6)) moments.push({ at: ball.label, text: ball.text });
    } else if (item.kind === 'event' && item.type !== 'start') {
      moments.push({ at: `after ${oversText(next.balls)} ov`, text: `${item.label}: ${item.text}` });
    }
    state = next;
  }
  return { state, balls, moments };
}

export function cricketStory(fixture: CricketFixture, lastSeq: number) {
  const first = innings('MI', MI_INNINGS.order, play(MI_INNINGS), null);
  const live = feed(fixture, lastSeq);
  const target = first.runs + 1;
  const chase = innings('CSK', CSK_TO_FEED.order, [...play(CSK_TO_FEED), ...live.balls], target);
  const s = live.state;
  const r = rates(s);

  // How the chase swung, over by over: the biggest moves in CSK's estimated chance (Huddle's formula, not a forecast).
  let before = chaseChance({ target, runs: 0, balls: 0, wkts: 0 });
  const swings = chase.overs.map((o) => {
    const move = { over: o, from: before, to: o.chance! };
    before = o.chance!;
    return move;
  }).filter((m) => Math.abs(m.to - m.from) >= 0.07)
    .sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from)).slice(0, 6)
    .sort((a, b) => a.over.over - b.over.over)
    .map(({ over: o, from, to }) => `Over ${o.over} (${o.bowler}): ${plural(o.runs, 'run')}${o.wkts ? `, ${plural(o.wkts, 'wicket')}` : ''}, CSK ${o.score}. CSK's estimated chance ${pct(from)}% to ${pct(to)}%, a swing towards ${to > from ? 'CSK' : 'MI'}.`);
  const bigOvers = (inn: typeof first, team: string) => inn.overs.filter((o) => o.runs >= 15 || o.runs <= 3)
    .map((o) => `${team} over ${o.over} (${o.bowler}): ${plural(o.runs, 'run')}${o.wkts ? `, ${plural(o.wkts, 'wicket')}` : ''}`);

  const sides = [{ team: 'MI', inn: first }, { team: 'CSK', inn: chase }];
  const all = (pick: (inn: typeof first) => Map<string, Bat> | Map<string, Bowl>) => sides.flatMap(({ team, inn }) => [...pick(inn)].map(([name, v]) => ({ name, team, v })));
  const batters = all((inn) => inn.bats) as { name: string; team: string; v: Bat }[];
  const bowlers = all((inn) => inn.bowls) as { name: string; team: string; v: Bowl }[];
  const total = (key: keyof typeof first.counts) => ({ MI: first.counts[key], CSK: chase.counts[key], match: first.counts[key] + chase.counts[key] });

  return {
    note: 'The complete record of this match from the first ball up to the latest ball. Nothing after the latest ball is known.',
    venue: VENUE,
    toss: TOSS,
    format: 'IPL T20, 20 overs a side',
    status: s.result ? `Finished: ${s.result}` : `In progress: CSK chasing ${target}, ${oversText(s.balls)} overs bowled`,
    first_innings: { ...first.card, did_not_bat: MI_DID_NOT_BAT, result_of_innings: `MI made ${first.runs}/${first.wkts}, so CSK need ${target} to win.` },
    second_innings: {
      ...chase.card,
      yet_to_bat: s.result ? [] : CSK_XI.filter((n) => !chase.bats.has(n)),
      ...(s.result ? {} : {
        situation_now: `CSK need ${r.need_runs} off ${r.need_balls} balls with ${10 - s.wkts} wickets in hand. Current run rate ${r.crr}, required rate ${r.rrr ?? 0}.`,
        at_the_crease: Object.entries(s.batters).map(([n, b]) => `${n} ${b.r} (${b.b})${n === s.striker ? ', on strike' : ''}`),
        bowling_now: chase.bowls.has(s.bowler) ? `${s.bowler} ${figures(chase.bowls.get(s.bowler)!)}` : s.bowler,
        this_over: s.this_over.join(' '),
        win_estimate: `CSK ${pct(chaseChance(s))}%, MI ${100 - pct(chaseChance(s))}%: Huddle's estimate from the score, balls left and wickets in hand, not a prediction of the result.`,
      }),
    },
    match_totals: {
      runs: { MI: first.runs, CSK: chase.runs, match: first.runs + chase.runs },
      wickets: { MI_lost: first.wkts, CSK_lost: chase.wkts, match: first.wkts + chase.wkts },
      sixes: total('sixes'), fours: total('fours'), dot_balls: total('dots'), singles: total('singles'), twos: total('twos'), threes: total('threes'),
      wides: total('wides'), leg_byes: total('leg_byes'),
    },
    leaders: {
      top_scorers: [...batters].sort((a, b) => b.v.r - a.v.r || a.v.b - b.v.b).slice(0, 5).map((p) => `${p.name} (${p.team}) ${p.v.r} off ${p.v.b}${p.v.out ? '' : ' not out'}`),
      best_bowling: [...bowlers].sort((a, b) => b.v.wkts - a.v.wkts || a.v.runs / Math.max(1, a.v.balls) - b.v.runs / Math.max(1, b.v.balls)).slice(0, 5)
        .map((p) => `${p.name} (${p.team === 'MI' ? 'CSK' : 'MI'}) ${p.v.wkts}/${p.v.runs} in ${oversText(p.v.balls)} overs`),
      most_sixes: [...batters].filter((p) => p.v.sixes).sort((a, b) => b.v.sixes - a.v.sixes).slice(0, 4).map((p) => `${p.name} (${p.team}) ${p.v.sixes}`),
    },
    key_moments: [
      ...first.moments.map((m) => `MI innings, ${m.at}: ${m.text}`),
      ...bigOvers(first, 'MI'),
      `End of MI innings: ${first.runs}/${first.wkts}.`,
      ...chase.moments.map((m) => `CSK chase, ${m.at}: ${m.text}`),
      ...bigOvers(chase, 'CSK'),
      ...live.moments.map((m) => `CSK chase, ${m.at}: ${m.text}`),
    ],
    chase_swings: swings,
  };
}
