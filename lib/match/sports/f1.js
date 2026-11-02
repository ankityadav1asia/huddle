// Formula 1: the final 13 laps of a made-up Italian Grand Prix at Monza, with real drivers. Labelled as a
// simulated race everywhere. Big moments, threads and crowd cues are marked in the script (see scripted.js).
import { makeFans } from '../fans.js';
import { scriptedSignals, scriptedThread, scriptedBurst, ROLE } from './scripted.js';

const DRIVERS = {
  VER: { name: 'Max Verstappen', short: 'Verstappen', team: 'Red Bull' },
  NOR: { name: 'Lando Norris', short: 'Norris', team: 'McLaren' },
  LEC: { name: 'Charles Leclerc', short: 'Leclerc', team: 'Ferrari' },
  PIA: { name: 'Oscar Piastri', short: 'Piastri', team: 'McLaren' },
  HAM: { name: 'Lewis Hamilton', short: 'Hamilton', team: 'Ferrari' },
  RUS: { name: 'George Russell', short: 'Russell', team: 'Mercedes' },
};
const TYRES = { S: 'soft', M: 'medium', H: 'hard' };
const TOTAL_LAPS = 53;
const short = (code) => DRIVERS[code].short;
const P = (lap, text, extra = {}) => ({ kind: 'play', clock: `Lap ${lap}`, lap, text, ...extra });
const E = (lap, type, label, text, extra = {}) => ({ kind: 'event', type, label, clock: `Lap ${lap}`, lap, text, ...extra });
const gapsOf = (list) => Object.fromEntries(list.map(([code, gap]) => [code, gap]));

const START = {
  lap: 41,
  order: ['VER', 'NOR', 'LEC', 'PIA', 'HAM', 'RUS'],
  gaps: gapsOf([['VER', 0], ['NOR', 1.8], ['LEC', 4.5], ['PIA', 6.1], ['HAM', 9.4], ['RUS', 12.0]]),
  tyres: { VER: 'M', NOR: 'H', LEC: 'H', PIA: 'M', HAM: 'H', RUS: 'M' },
  pits: { VER: 1, NOR: 1, LEC: 1, PIA: 1, HAM: 1, RUS: 1 },
  fastest: { driver: 'NOR', time: '1:22.4' },
};

const SCRIPT = [
  E(41, 'start', 'Final laps', 'Lap 41 of 53 at Monza: Verstappen leads Norris by 1.8 seconds, Leclerc third.', { crowd: { key: 'start', n: 8, spread: 6000 }, pause: 4000 }),
  P(42, 'Norris sets the fastest lap so far, 1:22.1, and the gap to Verstappen drops to 1.3 seconds.',
    { gaps: { NOR: 1.3 }, fastest: { driver: 'NOR', time: '1:22.1' }, crowd: { key: 'mcl_push', n: 5, share: 0.6 } }),
  P(42, 'Leclerc on the radio: his hard tyres are dropping off.'),
  E(43, 'pit', 'Pit stop', 'Leclerc boxes from P3 for soft tyres: an undercut try on Piastri. He rejoins P6.', {
    order: ['VER', 'NOR', 'PIA', 'HAM', 'RUS', 'LEC'], gaps: gapsOf([['VER', 0], ['NOR', 1.3], ['PIA', 5.9], ['HAM', 9.0], ['RUS', 11.6], ['LEC', 26.8]]),
    pit: { driver: 'LEC', tyre: 'S' },
    signal: { trigger: 'pit_stop', priority: 'low', label: 'Pit stop', fact: 'Leclerc pits for softs from P3 and rejoins P6.' },
    thread: { slug: 'pit-wall', about: 'Strategy calls: who pits, when, and on which tyres.', keywords: ['pit', 'undercut', 'overcut', 'tyre', 'tyres', 'tire', 'softs', 'mediums', 'box box'] },
    crowd: { key: 'pit', n: 6, spread: 4000, share: 0.5 }, pause: 3000,
  }),
  P(44, 'Leclerc on fresh softs is the quickest car on track: 1:21.8, the new fastest lap.', { fastest: { driver: 'LEC', time: '1:21.8' } }),
  P(44, 'Norris is within a second of Verstappen into the Rettifilo.', { gaps: { NOR: 0.9 }, crowd: { key: 'mcl_push', n: 6, share: 0.6 } }),
  E(45, 'safety_car', 'Safety car', 'SAFETY CAR! A car has stopped in the gravel at Ascari. The field bunches up behind the safety car.', {
    sc: true, gaps: gapsOf([['VER', 0], ['NOR', 0.4], ['PIA', 1.0], ['HAM', 1.6], ['RUS', 2.2], ['LEC', 2.9]]),
    signal: { trigger: 'safety_car', priority: 'high', label: 'Safety car', fact: (s) => `Safety car on lap ${s.lap}: ${short(s.order[0])} leads as the field closes up.` },
    thread: { slug: 'safety-car', about: 'A stopped car at Ascari brings out the safety car on lap 45.', keywords: ['safety car', 'vsc', 'neutralised', 'neutralized', 'ascari'] },
    moment: 'safety-car', crowd: { key: 'sc', n: 14, spread: 8000 }, pause: 5000, urgent: true,
  }),
  E(45, 'pit', 'Strategy call', 'Norris dives into the pits for softs under the safety car and keeps P2. Verstappen stays out on old mediums.', {
    pit: { driver: 'NOR', tyre: 'S' },
    signal: { trigger: 'strategy_call', priority: 'medium', label: 'Strategy split', fact: 'Norris pits for softs under the safety car and keeps P2; Verstappen stays out on old mediums.' },
    thread: { slug: 'pit-wall', about: 'Strategy calls: who pits, when, and on which tyres.', keywords: ['pit', 'undercut', 'overcut', 'tyre', 'tyres', 'tire', 'softs', 'mediums', 'box box'] },
    crowd: { key: 'pit_split', n: 12, spread: 7000 }, pause: 3000,
  }),
  P(46, 'Hamilton pits for softs too and drops behind Russell.', {
    order: ['VER', 'NOR', 'PIA', 'RUS', 'HAM', 'LEC'], gaps: gapsOf([['VER', 0], ['NOR', 0.4], ['PIA', 1.0], ['RUS', 1.7], ['HAM', 2.3], ['LEC', 2.9]]),
    pit: { driver: 'HAM', tyre: 'S' },
  }),
  E(47, 'restart', 'Restart', 'Green flag! Verstappen goes early at the restart, Norris stays within a second on fresh softs.', {
    sc: false, gaps: gapsOf([['VER', 0], ['NOR', 0.6], ['PIA', 1.4], ['RUS', 2.3], ['HAM', 3.0], ['LEC', 3.6]]),
    signal: { trigger: 'restart', priority: 'medium', label: 'Restart', fact: (s) => `Racing again on lap ${s.lap}: ${short(s.order[0])} leads ${short(s.order[1])} by ${s.gaps[s.order[1]]}s.` },
    moment: 'restart', crowd: { key: 'restart', n: 10, spread: 6000 }, pause: 3000,
  }),
  P(47, 'Leclerc passes Hamilton into the Roggia for P5.', {
    order: ['VER', 'NOR', 'PIA', 'RUS', 'LEC', 'HAM'], gaps: gapsOf([['VER', 0], ['NOR', 0.6], ['PIA', 1.5], ['RUS', 2.6], ['LEC', 3.1], ['HAM', 3.4]]),
    crowd: { key: 'overtake_mid', n: 4 },
  }),
  P(48, 'Norris is all over the back of Verstappen through the Lesmos.', { gaps: { NOR: 0.4 }, crowd: { key: 'mcl_push', n: 6, share: 0.6 } }),
  P(48, 'Verstappen defends the inside into the Rettifilo. Norris backs out.', { crowd: { key: 'max_defend', n: 7, share: 0.4 } }),
  P(49, 'Leclerc gets past Russell for P4.', {
    order: ['VER', 'NOR', 'PIA', 'LEC', 'RUS', 'HAM'], gaps: gapsOf([['VER', 0], ['NOR', 0.5], ['PIA', 1.8], ['LEC', 2.7], ['RUS', 3.3], ['HAM', 3.9]]),
    crowd: { key: 'overtake_mid', n: 4 },
  }),
  E(50, 'overtake', 'New leader', 'LEAD CHANGE! Norris goes around the outside at the Rettifilo and takes the lead from Verstappen!', {
    order: ['NOR', 'VER', 'PIA', 'LEC', 'RUS', 'HAM'], gaps: gapsOf([['NOR', 0], ['VER', 0.5], ['PIA', 1.9], ['LEC', 2.6], ['RUS', 3.8], ['HAM', 4.4]]),
    signal: { trigger: 'lead_change', priority: 'high', label: 'New leader', fact: 'Norris passes Verstappen for the lead on lap 50.' },
    thread: { slug: 'norris-vs-verstappen', about: 'Norris takes the lead from Verstappen at the Rettifilo on lap 50.', keywords: ['norris', 'lando', 'verstappen', 'max ', 'overtake'] },
    moment: 'lead-change', crowd: { key: 'lead_change', n: 18, spread: 9000 }, pause: 5000, urgent: true,
  }),
  P(50, 'Verstappen fights back on the run to Ascari, but Norris holds on.', { crowd: { key: 'battle', n: 8 } }),
  P(51, 'Verstappen gets a track limits warning at the Ascari chicane.', {
    signal: { trigger: 'track_limits', priority: 'low', label: 'Track limits', fact: 'Verstappen warned for track limits at Ascari on lap 51.' },
    crowd: { key: 'stewards', n: 6 },
  }),
  P(51, 'Fastest lap for Norris, 1:21.5, as he pulls 0.9 seconds clear.', {
    gaps: { VER: 0.9 }, fastest: { driver: 'NOR', time: '1:21.5' }, crowd: { key: 'mcl_push', n: 5, share: 0.65 },
  }),
  P(52, 'Leclerc passes Piastri for P3 into the Parabolica. The tifosi are on their feet!', {
    order: ['NOR', 'VER', 'LEC', 'PIA', 'RUS', 'HAM'], gaps: gapsOf([['NOR', 0], ['VER', 1.0], ['LEC', 2.8], ['PIA', 3.2], ['RUS', 4.9], ['HAM', 5.6]]),
    signal: { trigger: 'podium_change', priority: 'medium', label: 'Podium place', fact: 'Leclerc passes Piastri for P3 at the Parabolica on lap 52.' },
    crowd: { key: 'tifosi', n: 8 },
  }),
  E(53, 'last_lap', 'Final lap', 'Final lap! Norris leads Verstappen by 1.1 seconds.', {
    gaps: { VER: 1.1 },
    signal: { trigger: 'final_lap', priority: 'medium', label: 'Final lap', fact: (s) => `Final lap: ${short(s.order[0])} leads ${short(s.order[1])} by ${s.gaps[s.order[1]]}s.` },
    thread: { slug: 'last-lap', about: 'Norris starts the final lap 1.1 seconds ahead of Verstappen.', keywords: ['last lap', 'final lap', 'chequered', 'checkered'] },
    moment: 'last-lap', crowd: { key: 'last_lap', n: 12, spread: 7000 }, pause: 4000,
  }),
  P(53, 'Verstappen gives everything through the Lesmos, but the gap holds.', { crowd: { key: 'tension', n: 8 } }),
  E(53, 'result', 'Result', 'CHEQUERED FLAG! Lando Norris wins the Italian Grand Prix ahead of Max Verstappen and Charles Leclerc.', {
    result: 'Norris wins, Verstappen second, Leclerc third',
    signal: { trigger: 'match_result_confirmed', priority: 'high', label: 'Result', fact: 'Norris wins at Monza ahead of Verstappen and Leclerc.' },
    thread: { slug: 'result', about: 'Norris wins the Italian Grand Prix.', keywords: ['won', 'win', 'podium', 'p1'] },
    crowd: { key: 'win', n: 20, spread: 9000, share: 0.6 }, pause: 3000,
  }),
];

function initialState() {
  return { ...structuredClone(START), total: TOTAL_LAPS, sc: false, result: null, last_seq: -1, last_text: '' };
}

function applyItem(prev, item, seq) {
  const s = structuredClone(prev);
  s.last_seq = seq;
  s.last_text = item.text;
  if (item.lap) s.lap = item.lap;
  if (item.order) s.order = item.order;
  if (item.gaps) Object.assign(s.gaps, item.gaps);
  if (item.pit) {
    s.tyres[item.pit.driver] = item.pit.tyre;
    s.pits[item.pit.driver] += 1;
  }
  if ('sc' in item) s.sc = item.sc;
  if (item.fastest) s.fastest = item.fastest;
  if (item.result) s.result = item.result;
  return { state: s, ball: null };
}

function snapshot(s) {
  return {
    sport: 'f1', lap: s.lap, total_laps: s.total, safety_car: s.sc, result: s.result,
    leader: DRIVERS[s.order[0]].name,
    order: s.order.map((code, i) => ({
      pos: i + 1, code, name: DRIVERS[code].name, short: DRIVERS[code].short, team: DRIVERS[code].team,
      gap: i === 0 ? 'Leader' : `+${s.gaps[code].toFixed(1)}s`, tyre: TYRES[s.tyres[code]], pits: s.pits[code],
    })),
    fastest_lap: { driver: DRIVERS[s.fastest.driver].name, time: s.fastest.time },
  };
}

function facts(snap) {
  const sc = snap.score;
  return {
    headline: `Lap ${sc.lap}/${sc.total_laps} · ${sc.result || `${sc.order[0].short} leads${sc.safety_car ? ' · safety car' : ''}`}`,
    sport: 'f1', race: snap.match.title, status: snap.match.status, source_note: snap.match.source_label,
    lap: `${sc.lap}/${sc.total_laps}`, safety_car: sc.safety_car ? 'deployed' : 'not out', result: sc.result,
    running_order: sc.order.map((d) => `P${d.pos} ${d.name} (${d.team}) ${d.gap}, ${d.tyre} tyres, ${d.pits} pit stop${d.pits === 1 ? '' : 's'}`),
    fastest_lap: `${sc.fastest_lap.driver} ${sc.fastest_lap.time}`,
  };
}

function templatePoll(s) {
  if (s.result) return { question: 'Driver of the day?', options: [short(s.order[0]), short(s.order[2])] };
  return { question: 'Who wins at Monza?', options: [`${short(s.order[0])} holds on`, `${short(s.order[1])} wins it`] };
}

const CROWD = {
  start: {
    MCL: ['Papaya army ready 🧡', 'Lando ka time aa gaya hai 🔥', '1.8 seconds, catchable hai bhai', 'McLaren pace dekho aaj 🧡'],
    RBR: ['Max will manage this, relax 😎', 'Monza pe Max ka record dekh lo 😂', 'Red Bull strategy on point 💪', 'Max sabse aage, simple 🦁'],
  },
  mcl_push: {
    MCL: ['LANDO PUSH 🔥🔥', 'gap gir raha hai 📉', 'fastest lap aa gaya 🧡', 'bas ek second aur', 'purple sectors everywhere 💜'],
    RBR: ['Max tyres bacha raha hai, chill', 'abhi bhi P1 hai bhai 😤', 'thoda nervous hoon ngl 😬'],
  },
  pit: {
    MCL: ['undercut chal sakta hai?', 'Piastri ko cover karna padega 👀'],
    RBR: ['Ferrari ka gamble 🤔', 'softs pe 10 laps? risky'],
  },
  sc: {
    MCL: ['SAFETY CAR!! game on 🔥', 'free pit stop chance 👀', 'box box box Lando!!'],
    RBR: ['nooo safety car 😩', 'Max ka lead gaya 😤', 'ab restart pe sab hoga'],
  },
  pit_split: {
    MCL: ['fresh softs pe Lando = 🚀', 'McLaren ne sahi call liya 💯', 'ab Max old mediums pe hai 😏'],
    RBR: ['track position is king, Max stays out 👑', 'risky but Max can defend', 'hmm Red Bull ne pit kyun nahi kiya 🤔'],
  },
  restart: {
    MCL: ['restart pe jump nahi mila 😩', 'Lando close hai abhi bhi 🧡'],
    RBR: ['MAX restart master 😎', 'perfect restart 🦁', 'gap bana diya 💪'],
  },
  overtake_mid: {
    MCL: ['Ferrari aa rahi hai peeche se 👀', 'nice move 👏'],
    RBR: ['Leclerc on fire 🔴', 'tifosi wake up 🔴🔴'],
  },
  max_defend: {
    MCL: ['Max ne door band kar diya 😤', 'next lap Lando, next lap'],
    RBR: ['TEXTBOOK DEFENCE 🦁', 'Max ko pass karna itna easy nahi 😏', 'inside line locked 🔒'],
  },
  lead_change: {
    MCL: ['LANDOOOO 🧡🧡🧡', 'AROUND THE OUTSIDE!! 😱', 'P1 PAPAYA 🧡🔥', 'what a move yaar 🤯', 'Monza mein ye overtake!!'],
    RBR: ['nooo Max 😭', 'old tyres the bhai, no chance', 'still 3 laps left, Max is coming', 'fair move, respect 🤝'],
  },
  battle: {
    MCL: ['hold on Lando 🙏', 'wheel to wheel 😱', 'mirrors mein Max 😬'],
    RBR: ['Max pressure dalega 🦁', 'Ascari pe chance hai', 'COME ON MAX'],
  },
  stewards: {
    MCL: ['track limits!! stewards dekho 👀', 'ek aur aur penalty 😏'],
    RBR: ['bas warning hai, chill', 'stewards ko kuch aur kaam nahi 😤'],
  },
  tifosi: {
    MCL: ['Leclerc podium pe, fair', 'Oscar ko P3 chahiye tha 😩'],
    RBR: ['FORZA FERRARI 🔴', 'Parabolica pe kya move 🔥', 'tifosi going crazy 🔴🔴'],
  },
  last_lap: {
    MCL: ['ONE MORE LAP 🙏🧡', 'bring it home Lando', 'saans ruk gayi hai 😬'],
    RBR: ['Max abhi bhi chase karega 🦁', 'last lap magic please', '1.1s bahut hai yaar 😩'],
  },
  tension: {
    MCL: ['chalo chalo chalo 🙏', 'no mistakes Lando'],
    RBR: ['come on Max 💪', 'Lesmos pe gap kam hua?'],
  },
  win: {
    MCL: ['LANDO WINS MONZA 🧡🏆', 'PAPAYA PARTY 🧡🧡🧡', 'what a drive 🔥', 'strategy masterclass McLaren 💯', 'rona aa raha hai 😭🧡'],
    RBR: ['P2 still decent 💪', 'GG Lando, deserved 🤝', 'safety car ne race badal di 😤', 'next race Max wapas 🦁'],
  },
  chatter: {
    MCL: ['McLaren car rocket hai 🚀', 'tyres kaisi hai Lando ki?', 'pit wall sab sahi kar raha hai'],
    RBR: ['Max ka consistency unreal hai', 'Red Bull ko top speed chahiye', 'kya race hai yaar'],
  },
};

export const F1 = {
  key: 'f1-monza-demo',
  sport: 'f1',
  sportName: 'F1',
  title: 'Italian Grand Prix',
  teams: [{ code: 'MCL', name: 'McLaren' }, { code: 'RBR', name: 'Red Bull' }],
  format: 'Grand Prix',
  sourceLabel: 'Simulated race · demo data, not a live feed',
  items: SCRIPT,
  moments: [
    { id: 'safety-car', label: 'Safety car' }, { id: 'restart', label: 'Restart' },
    { id: 'lead-change', label: 'Lead change' }, { id: 'last-lap', label: 'Last lap' },
  ].map((m) => ({ ...m, index: SCRIPT.findIndex((s) => s.moment === m.id) })),
  engine: {
    initialState, applyItem, snapshot, facts, templatePoll,
    detectSignals: (prev, next, item, ball, seq) => scriptedSignals(next, item, seq),
    threadForItem: scriptedThread,
  },
  crowd: {
    lines: CROWD,
    fans: makeFans(['MCL', 'RBR'], ['papaya', 'apex', 'pitwall', 'boxbox', 'drs', 'slipstream', 'monza', 'tifosi', 'overcut', 'p1'], { seed: 'f1' }),
    burstFor: (item, state, rand) => scriptedBurst(item, rand, 0.4),
    fill: (text) => text,
    otherSide: (code) => (code === 'MCL' ? 'RBR' : 'MCL'),
    momentCues: new Set(['pit', 'sc', 'pit_split', 'restart', 'max_defend', 'lead_change', 'battle', 'stewards', 'last_lap', 'tension', 'win']),
  },
  topics: [
    { slug: 'safety-car', keywords: ['safety car', 'vsc', 'neutralised', 'neutralized'] },
    { slug: 'pit-wall', keywords: ['pit', 'undercut', 'overcut', 'tyre', 'tire', 'softs', 'mediums', 'box box'] },
    { slug: 'stewards', keywords: ['penalty', 'track limits', 'stewards', 'five second', '5 second'] },
  ],
  terms: /\b(?:lap\w*|pit\w*|box|tyres?|tires?|soft\w*|medium\w*|hard\w*|safety car|vsc|drs|overtak\w*|undercut|overcut|penalt\w*|track limits|stewards|flag\w*|grid|pole|podium|points?|fastest|gap|leader|chequered|checkered|race|grand prix|monza|verstappen|max|norris|lando|leclerc|charles|piastri|oscar|hamilton|lewis|russell|george|mclaren|ferrari|red bull|mercedes|win\w*|rule\w*)\b/i,
  rules: [
    { topic: 'The race', text: 'Drivers race a set number of laps (53 at Monza). The first car to complete them wins.' },
    { topic: 'Points', text: 'The top 10 score points: 25, 18, 15, 12, 10, 8, 6, 4, 2 and 1. There is no extra point for the fastest lap since 2025.' },
    { topic: 'Pit stops', text: 'Drivers stop in the pit lane for fresh tyres. A stop costs time, so teams plan when to make it.' },
    { topic: 'Tyres', text: 'Dry tyres come in soft (fastest, wears quickly), medium and hard (slowest, lasts longest). In a dry race every driver must use at least two different dry compounds.' },
    { topic: 'Safety car', text: 'When the track is unsafe a safety car leads the field at reduced speed and overtaking is banned. Gaps shrink, and a pit stop costs less time than usual.' },
    { topic: 'Virtual safety car', text: 'A virtual safety car makes every driver slow to a set pace without a physical car on track.' },
    { topic: 'Undercut and overcut', text: 'Undercut: pit before the car ahead and use fresh tyres to jump it. Overcut: stay out longer and build a gap before stopping.' },
    { topic: 'Overtaking aids', text: 'Until 2025 a chasing car within one second could open a rear-wing flap (DRS) on straights. The 2026 rules replaced DRS with movable wings for every car and an extra electric boost for a car close behind.' },
    { topic: 'Flags', text: 'Yellow: danger, no overtaking in that area. Blue: let a faster car that is lapping you pass. Red: the session is stopped. Chequered: the race is over.' },
    { topic: 'Track limits', text: 'Drivers must keep the car within the white lines. Repeated breaches bring a warning and then a time penalty, often 5 seconds.' },
    { topic: 'Retirements', text: 'A car that cannot finish retires (DNF). If it stops in a dangerous place, the safety car may come out.' },
  ],
  roster: Object.values(DRIVERS).map((d) => ROLE(d.name, d.team, 'driver')),
  examples: ['What is a safety car?', 'Why did Norris pit under the safety car?', 'Who is Lando Norris?'],
};
