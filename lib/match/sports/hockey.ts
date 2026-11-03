// Ice hockey: the third period of a made-up Oilers v Maple Leafs game, with real players. Labelled as a simulated
// game everywhere. Goals, shots and penalties are applied play by play, so the scoreboard always matches them.
import { makeFans } from '../fans.ts';
import { scriptedSignals, scriptedThread, scriptedBurst, ROLE } from './scripted.ts';

const TEAMS = { EDM: 'Oilers', TOR: 'Maple Leafs' };
const SIDES = [{ code: 'EDM', name: 'Oilers' }, { code: 'TOR', name: 'Maple Leafs' }];
const PLAYERS = {
  'Connor McDavid': { team: 'EDM', role: 'centre' }, 'Leon Draisaitl': { team: 'EDM', role: 'centre' },
  'Evan Bouchard': { team: 'EDM', role: 'defenceman' }, 'Zach Hyman': { team: 'EDM', role: 'left wing' },
  'Stuart Skinner': { team: 'EDM', role: 'goaltender' },
  'Auston Matthews': { team: 'TOR', role: 'centre' }, 'William Nylander': { team: 'TOR', role: 'right wing' },
  'John Tavares': { team: 'TOR', role: 'centre' }, 'Morgan Rielly': { team: 'TOR', role: 'defenceman' },
  'Anthony Stolarz': { team: 'TOR', role: 'goaltender' },
};
const line = (s) => `Oilers ${s.score.EDM}, Maple Leafs ${s.score.TOR}`;
const P = (clock, text, extra = {}) => ({ kind: 'play', clock: `P3 ${clock}`, game_clock: clock, text, ...extra });
const E = (clock, type, label, text, extra = {}) => ({ kind: 'event', type, label, clock: `P3 ${clock}`, game_clock: clock, text, ...extra });
const goal = (scorer, assists, strength = 'even strength') => ({ team: PLAYERS[scorer].team, scorer, assists, strength });
const POWER_PLAY = { slug: 'power-play', about: 'Penalties and power plays in the third period.', keywords: ['power play', 'powerplay', 'penalty kill', 'tripping', 'hooking', 'penalty'] };

const SCRIPT: any[] = [
  E('20:00', 'start', 'Third period', 'The third period is under way and it is 2-2.', { crowd: { key: 'start', n: 8, spread: 6000 }, pause: 4000 }),
  P('18:41', 'Matthews rips a wrist shot, Skinner gloves it.', { shot: 'TOR', crowd: { key: 'save', n: 4, share: 0.6 } }),
  P('17:30', 'Draisaitl one-timer from the slot, Stolarz kicks it away.', { shot: 'EDM' }),
  P('16:12', 'Rielly goes to the box for tripping McDavid. Oilers power play.', {
    penalty: { team: 'TOR', player: 'Morgan Rielly', infraction: 'tripping', until: '14:12' },
    signal: { trigger: 'power_play', priority: 'medium', label: 'Power play', fact: 'Rielly off for tripping: Oilers power play for 2 minutes.' },
    thread: POWER_PLAY, crowd: { key: 'penalty', n: 7, share: 0.5 },
  }),
  P('15:50', 'Bouchard blasts it from the point, Stolarz holds on.', { shot: 'EDM' }),
  P('15:21', 'McDAVID SCORES! Draisaitl finds him at the back door on the power play. Oilers lead!', {
    goal: goal('Connor McDavid', ['Leon Draisaitl', 'Evan Bouchard'], 'power play'),
    signal: { trigger: 'goal', priority: 'high', label: 'Goal', fact: (s) => `McDavid scores on the power play: ${line(s)}.` },
    thread: { slug: 'mcdavid-goal', about: 'Connor McDavid scores on the power play.', keywords: ['mcdavid', 'connor', 'mcjesus'] },
    moment: 'power-play-goal', crowd: { key: 'goal_edm', n: 16, spread: 8000, share: 0.15 }, pause: 5000, urgent: true,
  }),
  P('14:02', 'Nylander walks in and fires, Skinner says no.', { shot: 'TOR', crowd: { key: 'save', n: 4, share: 0.5 } }),
  P('12:47', 'NYLANDER! Matthews feeds him in the slot and it is tied again.', {
    goal: goal('William Nylander', ['Auston Matthews']),
    signal: { trigger: 'goal', priority: 'high', label: 'Goal', fact: (s) => `Nylander ties it: ${line(s)}.` },
    thread: { slug: 'nylander-goal', about: 'William Nylander ties the game.', keywords: ['nylander', 'willy'] },
    crowd: { key: 'goal_tor', n: 14, spread: 8000, share: 0.85 }, pause: 4000, urgent: true,
  }),
  P('11:30', 'Icing on the Leafs: a long clear from their own half. Faceoff back in the Toronto zone.', { crowd: { key: 'chatter', n: 2 } }),
  P('10:15', 'Huge save by Skinner on a Tavares deflection!', { shot: 'TOR', crowd: { key: 'save', n: 6, share: 0.4 } }),
  P('8:44', 'Hyman called for hooking. Leafs power play.', {
    penalty: { team: 'EDM', player: 'Zach Hyman', infraction: 'hooking', until: '6:44' },
    signal: { trigger: 'power_play', priority: 'medium', label: 'Power play', fact: 'Hyman off for hooking: Maple Leafs power play for 2 minutes.' },
    thread: POWER_PLAY, crowd: { key: 'penalty', n: 7, share: 0.5 },
  }),
  P('7:59', 'Matthews rings one off the post! So close.', { crowd: { key: 'post', n: 7 } }),
  E('6:44', 'pp_end', 'Penalty killed', 'The Oilers kill off the penalty. Back to five on five.', { pp_end: true, crowd: { key: 'pk', n: 5 } }),
  P('4:12', 'DRAISAITL! A rocket from the circle, McDavid with the assist. Oilers lead again!', {
    goal: goal('Leon Draisaitl', ['Connor McDavid']),
    signal: { trigger: 'goal', priority: 'high', label: 'Goal', fact: (s) => `Draisaitl puts the Oilers back in front: ${line(s)}.` },
    thread: { slug: 'draisaitl-goal', about: 'Leon Draisaitl gives the Oilers the lead late in the third.', keywords: ['draisaitl', 'leon'] },
    moment: 'go-ahead-goal', crowd: { key: 'goal_edm', n: 16, spread: 8000, share: 0.15 }, pause: 5000, urgent: true,
  }),
  P('3:05', 'McDavid in alone on a breakaway, Stolarz robs him!', { shot: 'EDM', crowd: { key: 'save', n: 6, share: 0.6 } }),
  E('1:45', 'empty_net', 'Goalie pulled', 'The Leafs pull Stolarz for an extra attacker. Six on five.', {
    empty_net: 'TOR',
    signal: { trigger: 'goalie_pulled', priority: 'medium', label: 'Goalie pulled', fact: (s) => `The Leafs pull their goalie, down ${s.score.EDM}-${s.score.TOR} with 1:45 left.` },
    thread: { slug: 'empty-net', about: 'Toronto pull their goalie for an extra attacker.', keywords: ['empty net', 'pull the goalie', 'pulled the goalie', 'extra attacker', 'six on five'] },
    moment: 'goalie-pulled', crowd: { key: 'empty_net', n: 9, spread: 6000 }, pause: 3000,
  }),
  P('0:58', 'Matthews winds up, Bouchard blocks it!', { crowd: { key: 'tension', n: 7 } }),
  P('0:31', 'McDavid into the empty net. That will do it.', {
    goal: goal('Connor McDavid', ['Zach Hyman'], 'empty net'),
    signal: { trigger: 'goal', priority: 'high', label: 'Goal', fact: (s) => `McDavid seals it into the empty net: ${line(s)}.` },
    thread: { slug: 'mcdavid-goal', about: 'Connor McDavid scores on the power play.', keywords: ['mcdavid', 'connor', 'mcjesus'] },
    crowd: { key: 'goal_edm', n: 12, spread: 7000, share: 0.2 }, pause: 4000,
  }),
  E('0:00', 'result', 'Final', 'FINAL: the Oilers win it.', {
    final: true,
    signal: { trigger: 'match_result_confirmed', priority: 'high', label: 'Result', fact: (s) => `Final: ${line(s)}. McDavid with two goals.` },
    thread: { slug: 'result', about: 'The final horn.', keywords: ['won', 'win', 'final score'] },
    crowd: { key: 'final', n: 12, spread: 7000 }, pause: 3000,
  }),
];

function initialState() {
  return {
    period: 'P3', clock: '20:00', score: { EDM: 2, TOR: 2 }, shots: { EDM: 24, TOR: 27 },
    goals: [], penalties: [], power_play: null, empty_net: null, result: null, last_seq: -1, last_text: '',
  };
}

function applyItem(prev, item, seq) {
  const s = structuredClone(prev);
  s.last_seq = seq;
  s.last_text = item.text;
  if (item.game_clock) s.clock = item.game_clock;
  if (item.shot) s.shots[item.shot] += 1;
  if (item.goal) {
    s.score[item.goal.team] += 1;
    s.shots[item.goal.team] += 1;
    s.goals.push({ ...item.goal, time: item.game_clock });
    // A minor penalty ends early when the team with the extra player scores.
    if (s.power_play?.team === item.goal.team) s.power_play = null;
  }
  if (item.penalty) {
    const p = item.penalty;
    s.penalties.push({ ...p, time: item.game_clock });
    s.power_play = { team: p.team === 'EDM' ? 'TOR' : 'EDM', until: p.until, player: p.player, infraction: p.infraction };
  }
  if (item.pp_end) s.power_play = null;
  if (item.empty_net) s.empty_net = item.empty_net;
  if (item.final) s.result = `${s.score.EDM > s.score.TOR ? 'Oilers' : 'Maple Leafs'} win ${Math.max(s.score.EDM, s.score.TOR)}-${Math.min(s.score.EDM, s.score.TOR)}`;
  return { state: s, ball: null };
}

function snapshot(s) {
  return {
    sport: 'hockey', period: s.period, clock: s.clock, result: s.result,
    teams: ['EDM', 'TOR'].map((code) => ({ code, name: TEAMS[code], score: s.score[code], shots: s.shots[code] })),
    power_play: s.power_play ? { team: TEAMS[s.power_play.team], until: s.power_play.until, penalty: `${s.power_play.player} (${s.power_play.infraction})` } : null,
    empty_net: s.empty_net ? TEAMS[s.empty_net] : null,
    goals: s.goals.map((g) => ({ team: TEAMS[g.team], scorer: g.scorer, assists: g.assists, time: g.time, strength: g.strength })),
    penalties: s.penalties.map((p) => ({ team: TEAMS[p.team], player: p.player, infraction: p.infraction, time: p.time })),
    last_play: s.last_text,
  };
}

function facts(snap) {
  const sc = snap.score;
  const [a, b] = sc.teams;
  return {
    headline: `${a.name} ${a.score}-${b.score} ${b.name} · ${sc.result || `${sc.period} ${sc.clock}`}${sc.power_play ? ` · ${sc.power_play.team} power play` : ''}`,
    sport: 'hockey', game: snap.match.title, status: snap.match.status, source_note: snap.match.source_label,
    period: sc.period, clock: sc.clock, score: `${a.name} ${a.score}, ${b.name} ${b.score}`, result: sc.result,
    shots_on_goal: `${a.name} ${a.shots}, ${b.name} ${b.shots}`,
    power_play: sc.power_play ? `${sc.power_play.team} until ${sc.power_play.until} (${sc.power_play.penalty})` : 'none',
    empty_net: sc.empty_net ? `${sc.empty_net} goalie pulled` : 'no',
    third_period_goals: sc.goals.map((g) => `${g.time} ${g.scorer} (${g.team}, ${g.strength})${g.assists.length ? `, assists ${g.assists.join(' and ')}` : ''}`),
    penalties: sc.penalties.map((p) => `${p.time} ${p.player} (${p.team}) ${p.infraction}`),
    last_play: sc.last_play,
  };
}

function templatePoll(s) {
  if (s.result) return { question: 'Player of the game?', options: ['Connor McDavid', 'William Nylander'] };
  return { question: 'Who takes this one?', options: ['Oilers', 'Maple Leafs'] };
}

const CROWD = {
  start: {
    EDM: ['Let\'s go Oilers 🧡💙', '2-2, McDavid ka time aa gaya', 'third period is ours'],
    TOR: ['Go Leafs Go 💙🤍', 'Matthews will win this', 'tied game, full josh'],
  },
  save: {
    EDM: ['Skinner wall hai 🧱', 'what a save 🧤'],
    TOR: ['Stolarz unbelievable 🧤', 'big save yaar'],
  },
  penalty: {
    EDM: ['power play time ⚡', 'clear penalty tha', 'ab McDavid ko space milega'],
    TOR: ['soft call 😤', 'refs pls 🙄', 'kill this penalty boys'],
  },
  goal_edm: {
    EDM: ['McDAVIDDDD 🧡🔥', 'GOAL GOAL GOAL 🚨', 'kya pass tha Leon ka 😱', 'unstoppable yaar', 'OILERS LEAD 🧡💙'],
    TOR: ['nooo 😩', 'defence kahan thi', 'abhi time hai, chill', 'McDavid is a cheat code 😤'],
  },
  goal_tor: {
    EDM: ['ugh tied again 😩', 'coverage kahan gaya'],
    TOR: ['WILLY 🔥🔥', 'NYLANDER STYLE 😎', 'GAME ON 💙', 'Matthews ka pass dekha?? 🤯'],
  },
  post: {
    EDM: ['post ne bacha liya 😅', 'phew 😮‍💨'],
    TOR: ['POST 😱', 'itna close!!'],
  },
  pk: {
    EDM: ['penalty killed 💪', 'great kill boys'],
    TOR: ['power play waste ho gaya 😩'],
  },
  empty_net: {
    EDM: ['empty net, bas clear karo', 'McDavid empty net mein daal do'],
    TOR: ['six on five, all in 🙏', 'last push Leafs 💙'],
  },
  tension: {
    EDM: ['block it 🙏', 'one minute left 😬'],
    TOR: ['shoot shoot shoot', 'come on 🙏'],
  },
  final: {
    EDM: ['OILERS WIN 🧡💙🏒', 'McDavid show 🔥', 'what a third period'],
    TOR: ['next game Leafs 💙', 'close tha yaar 😩'],
  },
  chatter: {
    EDM: ['Bouchard ka shot dekho 🚀', 'forecheck strong hai'],
    TOR: ['Leafs pace badhao', 'Tavares underrated hai'],
  },
};

export const HOCKEY = {
  key: 'nhl-edm-tor-demo',
  sport: 'hockey',
  sportName: 'hockey',
  title: 'Oilers v Maple Leafs',
  teams: SIDES,
  format: 'NHL',
  sourceLabel: 'Simulated game · demo data, not a live feed',
  items: SCRIPT,
  moments: [{ id: 'power-play-goal', label: 'Power-play goal' }, { id: 'go-ahead-goal', label: 'Late goal' }, { id: 'goalie-pulled', label: 'Goalie pulled' }]
    .map((m) => ({ ...m, index: SCRIPT.findIndex((s) => s.moment === m.id) })),
  engine: {
    initialState, applyItem, snapshot, facts, templatePoll,
    detectSignals: (prev, next, item, ball, seq) => scriptedSignals(next, item, seq),
    threadForItem: scriptedThread,
  },
  crowd: {
    lines: CROWD,
    fans: makeFans(['EDM', 'TOR'], ['slapshot', 'powerplay', 'icebox', 'hattrick', 'faceoff', 'puck', 'oilcountry', 'leafsnation', 'snipe', 'nhl'], { seed: 'hockey' }),
    burstFor: (item, state, rand) => scriptedBurst(item, rand, 0.4),
    fill: (text) => text,
    otherSide: (code) => (code === 'EDM' ? 'TOR' : 'EDM'),
    momentCues: new Set(['penalty', 'goal_edm', 'goal_tor', 'pk', 'post', 'empty_net', 'tension', 'final']),
  },
  topics: [
    { slug: 'refs', keywords: ['refs', 'soft call', 'offside', 'icing', 'challenge'] },
    { slug: 'goalies', keywords: ['goalie', 'goaltender', 'save', 'glove'] },
  ],
  terms: /\b(?:goals?|score\w*|shots?|saves?|period\w*|overtime|shootout|power.?play|penalt\w*|penalty kill|minor|major|icing|offside|faceoff|empty net|pull\w* the goalie|goalie|goaltender|assists?|hat.?trick|tripping|hooking|slashing|mcdavid|connor|draisaitl|leon|bouchard|hyman|skinner|matthews|auston|nylander|tavares|rielly|stolarz|oilers|leafs|maple leafs|win\w*|rule\w*)\b/i,
  rules: [
    { topic: 'Game length', text: 'An NHL game has three 20-minute periods. A tied regular-season game goes to 5 minutes of 3-on-3 overtime, then a shootout.' },
    { topic: 'Goals and assists', text: 'A goal counts when the whole puck crosses the goal line. Up to two teammates who touched it just before get assists.' },
    { topic: 'Minor penalty', text: 'A minor penalty (tripping, hooking, slashing and others) sends the player to the penalty box for 2 minutes.' },
    { topic: 'Power play', text: 'While a player serves a penalty the other team has an extra skater: a power play. A minor penalty ends early if the power-play team scores.' },
    { topic: 'Major penalty', text: 'A major penalty lasts 5 minutes and does not end when the other team scores.' },
    { topic: 'Penalty kill', text: 'The short-handed team defends with one player fewer until the penalty ends.' },
    { topic: 'Icing', text: 'Icing: shooting the puck from your own half past the other team\'s goal line untouched. Play stops and the faceoff goes back to your zone. It is not called when your team is short-handed.' },
    { topic: 'Offside', text: 'Attacking players may not enter the offensive zone before the puck does.' },
    { topic: 'Pulling the goalie', text: 'A team trailing late often swaps its goalie for an extra attacker, risking a goal into the empty net.' },
    { topic: 'Shots on goal', text: 'A shot on goal is one that would go in if the goalie did not stop it; shots that hit the post do not count.' },
    { topic: 'Hat trick', text: 'A hat trick is three goals by one player in a game.' },
  ],
  roster: Object.entries(PLAYERS).map(([name, p]) => ROLE(name, TEAMS[p.team], p.role)),
  // What a fan can back: a team and up to three players.
  backing: {
    teams: SIDES,
    players: Object.entries(PLAYERS).map(([name, p]) => ({ name, short: name.split(' ').slice(-1)[0], team: p.team })),
  },
  examples: ['What is a power play?', 'What is icing?', 'Who is Connor McDavid?'],
};
