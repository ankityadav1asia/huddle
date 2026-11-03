// Basketball: the last six minutes of a made-up Warriors v Lakers game, with real players. Points are added up from
// the plays, so the scoreboard always matches them.
import type { FactsInput, Fixture, PollTemplate, Team } from '../fixture.ts';
import { makeFans } from '../fans.ts';
import { scriptedSignals, scriptedThread, scriptedBurst, scriptedDescribe, scoreWorm, ROLE, type ScriptedItem } from './scripted.ts';

// The game as the script has it. Scores and team fouls (this quarter) are by team code, points by player.
interface BasketballState {
  period: string;
  clock: string;
  score: Record<string, number>;
  fouls: Record<string, number>;
  players: Record<string, { team: string; pts: number }>;
  result: string | null;
  last_seq: number;
  last_text: string;
}

// A play or event of the quarter: `score` is a basket or free throws, `foul` the team that fouled.
interface BasketballItem extends ScriptedItem<BasketballState> {
  game_clock: string;
  score?: { player: string; team: string; points: number };
  foul?: string;
  final?: boolean;
}
type Extra = Omit<BasketballItem, 'kind' | 'clock' | 'game_clock' | 'text' | 'type' | 'label'>;
type BasketballScore = ReturnType<typeof snapshot>;

const TEAMS: Record<string, string> = { LAL: 'Lakers', GSW: 'Warriors' };
const SIDES: Team[] = [{ code: 'GSW', name: 'Warriors' }, { code: 'LAL', name: 'Lakers' }];
// `pts`: points before the last six minutes.
const PLAYERS: Record<string, { team: string; role: string; pts: number }> = {
  'Luka Dončić': { team: 'LAL', role: 'guard', pts: 27 },
  'LeBron James': { team: 'LAL', role: 'forward', pts: 22 },
  'Austin Reaves': { team: 'LAL', role: 'guard', pts: 16 },
  'Stephen Curry': { team: 'GSW', role: 'guard', pts: 28 },
  'Jimmy Butler': { team: 'GSW', role: 'forward', pts: 19 },
  'Draymond Green': { team: 'GSW', role: 'forward', pts: 8 },
};
const last = (name: string) => name.split(' ').slice(-1)[0];
const line = (s: BasketballState) => `Warriors ${s.score.GSW}, Lakers ${s.score.LAL}`;
const P = (clock: string, text: string, extra: Extra = {}): BasketballItem => ({ kind: 'play', clock: `Q4 ${clock}`, game_clock: clock, text, ...extra });
const E = (clock: string, type: string, label: string, text: string, extra: Extra = {}): BasketballItem => ({ kind: 'event', type, label, clock: `Q4 ${clock}`, game_clock: clock, text, ...extra });
const scored = (player: string, points: number) => ({ player, team: PLAYERS[player].team, points });
const CURRY_THREES = { slug: 'curry-threes', about: 'Stephen Curry heats up from deep in the fourth quarter.', keywords: ['curry', 'steph', 'splash', 'from deep'] };

const SCRIPT: BasketballItem[] = [
  E('6:00', 'start', 'Fourth quarter', 'Six minutes left in the fourth: the Lakers lead 98-96.', { crowd: { key: 'start', n: 8, spread: 6000 }, pause: 4000 }),
  P('5:41', 'Curry pulls up from 28 feet... BANG! Warriors in front.', { score: scored('Stephen Curry', 3), crowd: { key: 'curry_three', n: 6, share: 0.35 } }),
  P('5:20', 'Dončić answers with a step-back three over Green.', { score: scored('Luka Dončić', 3), crowd: { key: 'luka', n: 6, share: 0.65 } }),
  P('5:02', 'Butler drives, gets fouled and makes both free throws. Tied up.', { score: scored('Jimmy Butler', 2), foul: 'LAL' }),
  P('4:40', 'LeBron James throws it down in transition!', { score: scored('LeBron James', 2), crowd: { key: 'lebron', n: 6, share: 0.7 } }),
  P('4:21', 'Curry again from the logo. Warriors back in front!', {
    score: scored('Stephen Curry', 3),
    signal: { trigger: 'hot_hand', priority: 'medium', label: 'Hot hand', fact: (s) => `Curry hits another three: ${line(s)}. He has ${s.players['Stephen Curry'].pts} points.` },
    thread: CURRY_THREES, crowd: { key: 'curry_three', n: 9, spread: 5000, share: 0.3 },
  }),
  P('4:05', 'Reaves floats one in over the outstretched arm of Green.', { score: scored('Austin Reaves', 2) }),
  P('3:48', 'Green fouls Dončić on the drive, his fifth foul. Dončić makes both.', { score: scored('Luka Dončić', 2), foul: 'GSW', crowd: { key: 'foul', n: 5 } }),
  E('3:30', 'timeout', 'Timeout', 'Warriors call timeout to draw up a play.', { crowd: { key: 'timeout', n: 4 } }),
  P('3:12', 'Butler hits the mid-range jumper over Reaves.', { score: scored('Jimmy Butler', 2) }),
  P('2:55', 'Dončić misses from deep, Green grabs it, and Curry buries ANOTHER three!', {
    score: scored('Stephen Curry', 3),
    signal: { trigger: 'lead_change', priority: 'medium', label: 'Lead change', fact: (s) => `Curry's third three of the quarter: ${line(s)}.` },
    thread: CURRY_THREES, crowd: { key: 'curry_three', n: 10, spread: 5000, share: 0.3 },
  }),
  P('2:31', 'LeBron powers through contact, scores and makes the free throw. And-one!', {
    score: scored('LeBron James', 3),
    signal: { trigger: 'lead_change', priority: 'medium', label: 'Lead change', fact: (s) => `LeBron's and-one puts the Lakers back in front: ${line(s)}.` },
    crowd: { key: 'lebron', n: 8, share: 0.7 },
  }),
  E('2:00', 'clutch', 'Clutch time', 'Two minutes left and it is a one-point game.', {
    signal: { trigger: 'clutch_time', priority: 'medium', label: 'Clutch time', fact: (s) => `Two minutes left: ${line(s)}.` },
    thread: { slug: 'clutch-time', about: 'The last two minutes of a one-point game.', keywords: ['clutch', 'last shot', 'final minute', 'timeout', 'buzzer'] },
    moment: 'clutch', crowd: { key: 'clutch', n: 10, spread: 6000 }, pause: 3000,
  }),
  P('1:44', 'Curry drives and is fouled by Reaves. The Lakers are in the penalty, so Curry shoots two and makes both.', { score: scored('Stephen Curry', 2), foul: 'LAL', crowd: { key: 'foul', n: 5 } }),
  P('1:21', 'Dončić step-back three. Ice cold.', { score: scored('Luka Dončić', 3), crowd: { key: 'luka', n: 9, share: 0.7 } }),
  P('1:02', 'Butler gets to the rim and ties it up.', { score: scored('Jimmy Butler', 2), crowd: { key: 'tension', n: 6 } }),
  P('0:41', 'LeBron misses the fadeaway, Butler pulls down the rebound.', { crowd: { key: 'tension', n: 6 } }),
  E('0:24', 'timeout', 'Timeout', 'Curry misses a three, LeBron rebounds, and the Lakers call timeout.', { crowd: { key: 'timeout', n: 5 } }),
  P('0:09', 'Dončić drives and lays it in. Lakers by two!', {
    score: scored('Luka Dončić', 2),
    signal: { trigger: 'go_ahead', priority: 'high', label: 'Go-ahead basket', fact: (s) => `Dončić scores with 9 seconds left: ${line(s)}.` },
    crowd: { key: 'luka', n: 12, spread: 6000, share: 0.75 }, pause: 3000,
  }),
  E('0:04', 'timeout', 'Timeout', 'Warriors timeout with 4 seconds left. One last play.', { moment: 'last-shot', crowd: { key: 'tension', n: 8 }, pause: 3000 }),
  P('0:00', 'CURRY AT THE BUZZER... GOOD! A three from 30 feet wins it for Golden State!', {
    score: scored('Stephen Curry', 3),
    signal: { trigger: 'buzzer_beater', priority: 'high', label: 'Buzzer-beater', fact: (s) => `Curry's buzzer-beating three wins it: ${line(s)}.` },
    thread: { slug: 'buzzer-beater', about: 'Stephen Curry hits a three at the buzzer to win it.', keywords: ['buzzer', 'game winner', 'dagger', 'night night'] },
    crowd: { key: 'buzzer', n: 22, spread: 9000, share: 0.3 }, pause: 5000,
  }),
  E('0:00', 'result', 'Final', 'FINAL: the Warriors win a classic.', {
    final: true,
    signal: { trigger: 'match_result_confirmed', priority: 'high', label: 'Result', fact: (s) => `Final: ${line(s)}. Curry finishes with ${s.players['Stephen Curry'].pts} points.` },
    thread: { slug: 'result', about: 'The final whistle.', keywords: ['won', 'win', 'final score'] },
    crowd: { key: 'final', n: 12, spread: 7000 }, pause: 3000,
  }),
];

function initialState(): BasketballState {
  return {
    period: 'Q4', clock: '6:00', score: { LAL: 98, GSW: 96 }, fouls: { LAL: 2, GSW: 3 },
    players: Object.fromEntries(Object.entries(PLAYERS).map(([name, p]) => [name, { team: p.team, pts: p.pts }])),
    result: null, last_seq: -1, last_text: '',
  };
}

function applyItem(prev: BasketballState, item: BasketballItem, seq: number) {
  const s = structuredClone(prev);
  s.last_seq = seq;
  s.last_text = item.text;
  if (item.game_clock) s.clock = item.game_clock;
  if (item.score) {
    s.score[item.score.team] += item.score.points;
    s.players[item.score.player].pts += item.score.points;
  }
  if (item.foul) s.fouls[item.foul] += 1;
  if (item.final) s.result = `${s.score.GSW > s.score.LAL ? 'Warriors' : 'Lakers'} win ${Math.max(s.score.GSW, s.score.LAL)}-${Math.min(s.score.GSW, s.score.LAL)}`;
  return { state: s, ball: null };
}

function snapshot(s: BasketballState) {
  const leaders = (team: string) => Object.entries(s.players).filter(([, p]) => p.team === team).sort((a, b) => b[1].pts - a[1].pts)
    .map(([name, p]) => ({ name, short: last(name), pts: p.pts }));
  return {
    sport: 'basketball', period: s.period, clock: s.clock, result: s.result,
    teams: ['GSW', 'LAL'].map((code) => ({ code, name: TEAMS[code], score: s.score[code], team_fouls: s.fouls[code], leaders: leaders(code) })),
    last_play: s.last_text,
  };
}

function facts(snap: FactsInput<BasketballScore>) {
  const sc = snap.score;
  const [a, b] = sc.teams;
  return {
    headline: `${a.name} ${a.score}-${b.score} ${b.name} · ${sc.result || `${sc.period} ${sc.clock}`}`,
    sport: 'basketball', game: snap.match.title, status: snap.match.status, source_note: snap.match.source_label,
    period: sc.period, clock: sc.clock, score: `${a.name} ${a.score}, ${b.name} ${b.score}`, result: sc.result,
    team_fouls_this_quarter: `${a.name} ${a.team_fouls}, ${b.name} ${b.team_fouls}`,
    points: sc.teams.flatMap((t) => t.leaders.map((p) => `${p.name} (${t.name}) ${p.pts} points`)),
    last_play: sc.last_play,
  };
}

function templatePoll(s: BasketballState): PollTemplate {
  if (s.result) return { question: 'Player of the game?', options: ['Stephen Curry', 'Luka Dončić'] };
  return { question: 'Who wins this one?', options: ['Warriors', 'Lakers'] };
}

const CROWD = {
  start: {
    GSW: ['Dub Nation in the house 💛💙', 'two points, nothing hai', 'Steph ko ball do bas'],
    LAL: ['Lakers in control 💜💛', 'Luka + LeBron = cheat code', 'close it out boys'],
  },
  curry_three: {
    GSW: ['SPLASH 💦💦', 'Steph is unreal yaar 🔥', 'logo se!! 😱', 'chef curry cooking 👨‍🍳', 'ye aadmi miss nahi karta'],
    LAL: ['koi Steph ko guard karo pls 😩', 'switch kyun kiya 🤦', 'that was a heat check', 'defence kahan hai'],
  },
  luka: {
    GSW: ['Luka ka step-back unguardable hai 😤', 'contest tha phir bhi'],
    LAL: ['LUKA MAGIC ✨', 'step-back king 👑', 'ice in his veins 🧊', 'Luka ko rokna impossible'],
  },
  lebron: {
    GSW: ['LeBron abhi bhi aisa?? 😳', 'box out karo yaar'],
    LAL: ['KING JAMES 👑', 'what a finish 💪', 'age is just a number 😂', 'and-one baby!'],
  },
  foul: {
    GSW: ['soft foul tha 😤', 'refs ko kya ho gaya'],
    LAL: ['clear foul bhai', 'free points 🙏', 'bonus mein aa gaye'],
  },
  timeout: {
    GSW: ['Steph ke liye play banao', 'Kerr ka play dekhna'],
    LAL: ['defence set karo', 'Luka ko ball do 🙏'],
  },
  clutch: {
    GSW: ['clutch time = Steph time ⏰', 'saans roko 😬'],
    LAL: ['ab Luka ka time 🧊', 'one stop needed'],
  },
  tension: {
    GSW: ['one more stop 🙏', 'chalo Dubs'],
    LAL: ['rebound lo yaar', 'come on Lakers'],
  },
  buzzer: {
    GSW: ['NIGHT NIGHT 😴😴', 'STEPH AT THE BUZZER!!! 🤯', 'kya shot hai 🔥🔥', 'greatest shooter ever, no debate', 'rona aa gaya 😭💛'],
    LAL: ['NOOOO 😭', 'itna contest ke baad bhi 😩', 'heartbreak 💔', 'respect, kya shot tha 🤝'],
  },
  final: {
    GSW: ['what a game 🏀🔥', 'Dubs win 💛💙'],
    LAL: ['close tha yaar 😩', 'next time 💜💛'],
  },
  chatter: {
    GSW: ['Draymond defence pe solid', 'bench ko bhi credit'],
    LAL: ['Reaves underrated hai', 'pace bohot fast hai'],
  },
};

export const BASKETBALL: Fixture<BasketballState, BasketballItem, BasketballScore> = {
  key: 'nba-gsw-lal-demo',
  sport: 'basketball',
  sportName: 'basketball',
  title: 'Warriors v Lakers',
  teams: SIDES,
  format: 'NBA',
  sourceLabel: 'Play-by-play game feed',
  items: SCRIPT,
  engine: {
    initialState, applyItem, snapshot, facts, templatePoll,
    detectSignals: (_prev, next, item, _ball, seq) => scriptedSignals(next, item, seq),
    threadForItem: scriptedThread,
    describe: scriptedDescribe,
    graphs: (states) => scoreWorm(states, SIDES.map((t) => t.code)),
  },
  crowd: {
    lines: CROWD,
    fans: makeFans(['GSW', 'LAL'], ['splash', 'dunks', 'threes', 'courtside', 'hoops', 'buckets', 'dubnation', 'lakeshow', 'kingjames', 'nba'], { seed: 'basketball' }),
    burstFor: (item, _state, rand) => scriptedBurst(item, rand, 0.4),
    fill: (text) => text,
    otherSide: (code) => (code === 'GSW' ? 'LAL' : 'GSW'),
    momentCues: new Set(['curry_three', 'clutch', 'tension', 'timeout', 'buzzer', 'final']),
  },
  topics: [
    { slug: 'refs', keywords: ['foul', 'refs', 'whistle', 'flop', 'travel'] },
    { slug: 'threes', keywords: ['three', 'splash', 'from deep', '3pt'] },
  ],
  terms: /\b(?:points?|score\w*|three\w*|3pt|free throws?|fouls?|bonus|penalty|shot clock|timeouts?|quarter|overtime|rebound\w*|assist\w*|dunk\w*|layup|travel\w*|goaltending|technical|and.?one|buzzer|clutch|curry|steph|butler|jimmy|draymond|green|doncic|dončić|luka|lebron|james|reaves|warriors|lakers|win\w*|rule\w*)\b/i,
  rules: [
    { topic: 'Game length', text: 'An NBA game has four 12-minute quarters. If it is tied, teams play 5-minute overtime periods.' },
    { topic: 'Scoring', text: 'A basket inside the three-point line is worth 2 points, one from behind it 3 points, and each free throw 1 point.' },
    { topic: 'Shot clock', text: 'A team has 24 seconds to attempt a shot that hits the rim. Some fouls and offensive rebounds reset it to 14 seconds.' },
    { topic: 'Personal fouls', text: 'A player who commits 6 personal fouls fouls out and must leave the game.' },
    { topic: 'Bonus (penalty)', text: 'After a team commits 5 fouls in a quarter (or 2 in the last two minutes), every further foul gives the other team free throws.' },
    { topic: 'Shooting fouls', text: 'A player fouled while shooting gets 2 or 3 free throws, matching the shot. If the shot goes in anyway, it counts plus 1 free throw: an and-one.' },
    { topic: 'Timeouts', text: 'Teams call timeouts to stop the clock and plan; late in the game a timeout can also move the ball up to the frontcourt.' },
    { topic: 'Technical fouls', text: 'A technical foul is for unsportsmanlike conduct; the other team gets 1 free throw.' },
    { topic: 'Goaltending', text: 'Blocking a shot on its way down towards the basket, or touching the ball above the rim, is goaltending: the basket counts.' },
    { topic: 'Traveling', text: 'Taking too many steps without dribbling is a travel, a turnover.' },
    { topic: 'Buzzer-beater', text: 'A shot released before the clock reaches zero counts even if it goes in after the buzzer.' },
  ],
  roster: Object.entries(PLAYERS).map(([name, p]) => ROLE(name, TEAMS[p.team], p.role)),
  backing: {
    teams: SIDES,
    players: Object.entries(PLAYERS).map(([name, p]) => ({ name, short: last(name), team: p.team })),
  },
  examples: ['What is the shot clock?', 'Why did Curry get two free throws?', 'Who is Luka Dončić?'],
};
