// Cricket: the scripted MI v CSK chase (real players, made-up match). Big moments come from deterministic rules
// (lib/match/momentum.js) rather than the script; everything else follows the shared sport interface.
import { START, SCRIPT, MOMENTS, TEAMS, SQUADS, CROWD, FANS, otherTeam, shortName } from '../demo-script.js';
import { initialState, applyItem, snapshot, rates } from '../scorecard.js';
import { detectSignals } from '../momentum.js';
import { makeFans } from '../fans.js';

const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);

// Topics people argue about, in Hinglish and English (from the original demo). The first match wins.
const TOPICS = [
  { slug: 'dropped-catch', keywords: ['chhod', 'drop', 'sitter', 'catches win', 'lifeline', 'butter', 'bach gaya', 'chhoot'] },
  { slug: 'drs-call', keywords: ['drs', 'review', 'umpire', 'lbw', 'ball tracking', 'plumb', 'leg ke bahar', 'going down', 'hitting'] },
  { slug: 'last-over', keywords: ['last over', 'final over', 'off 6', 'ek boundary', 'saans', 'wide yorker', 'nerves'] },
  { slug: 'bowling-change', keywords: ['bowling change', 'part-timer', 'part timer', 'bumrah kahan', 'bumrah kyun', 'masterstroke',
    'golden arm', 'tilak ko', 'kisne bola', 'hardik ko'] },
];
const topicKeywords = (slug) => TOPICS.find((t) => t.slug === slug)?.keywords || [];

// The thread a ball or event opens: a wicket, a drop, the DRS call, the bowling change, the last over, the result.
function threadForItem(item) {
  if (item.wicket) {
    const who = shortName(item.wicket.out);
    return { slug: `${slugify(who)}-out`, about: `${item.wicket.out} out, ${item.wicket.how}.`, keywords: [who.toLowerCase()] };
  }
  if (item.drop) return { slug: 'dropped-catch', about: `${item.drop.by} drops ${item.bat}.`, keywords: topicKeywords('dropped-catch') };
  if (item.moment === 'drs' || (item.kind === 'event' && item.type === 'review')) {
    return { slug: 'drs-call', about: item.text, keywords: topicKeywords('drs-call') };
  }
  if (item.kind !== 'event') return null;
  if (item.type === 'bowling_change') return { slug: 'bowling-change', about: item.text, keywords: topicKeywords('bowling-change') };
  if (item.type === 'last_over') return { slug: 'last-over', about: item.text, keywords: topicKeywords('last-over') };
  if (item.type === 'result') return { slug: 'result', about: item.text, keywords: ['won', 'win', 'jeet', 'champion'] };
  return null;
}

// What the AI may state about the match: built from the verified snapshot only.
function facts(snap) {
  const s = snap.score;
  return {
    headline: `${s.batting} ${s.runs}/${s.wickets} (${s.overs})${s.result ? ` · ${s.result}` : s.need_runs ? ` · need ${s.need_runs} off ${s.need_balls}` : ''}`,
    match: snap.match.title, sport: 'cricket', format: snap.match.format, status: snap.match.status,
    source: snap.match.source, source_note: snap.match.source_label,
    batting: s.batting, bowling: s.bowling, score: `${s.runs}/${s.wickets}`, overs: s.overs, target: s.target,
    need_runs: s.need_runs, balls_left: s.need_balls, current_run_rate: s.crr, required_run_rate: s.rrr,
    first_innings: s.first_innings, result: s.result,
    batters: s.batters.map((b) => `${b.name} ${b.runs} (${b.balls})${b.on_strike ? ' on strike' : ''}`),
    bowler: s.bowler ? `${s.bowler.name} ${s.bowler.figures}` : null,
    bowling_card: s.bowling_card.map((b) => `${b.name} ${b.figures}`),
    fall_of_wickets: s.fall_of_wickets.map((w) => `${w.name} ${w.r} (${w.b}) ${w.how}${w.score ? ` at ${w.score}` : ''}${w.over ? ` in ${w.over} ov` : ''}`),
    this_over: s.this_over.join(' '),
  };
}

function templatePoll(state) {
  const r = rates(state);
  if (state.result || r.need_runs === 0) return { question: 'Player of the match?', options: [`${state.batting} batter`, `${state.bowling} bowler`] };
  return { question: `${state.batting} need ${r.need_runs} off ${r.need_balls}. Who wins?`, options: [`${state.batting} chase it`, `${state.bowling} defend it`] };
}

// The script's crowd cue for an item, or the background chatter the original demo played between cues.
function burstFor(item, state, rand) {
  if (item.crowd) return item.crowd;
  if (item.kind === 'overend') return { key: 'overend', n: 3, spread: 2400 };
  if (item.kind !== 'ball') return null;
  if (item.runs >= 4 && !item.extra) return { key: 'boundary', n: 3, spread: 2500 };
  if (item.runs === 0) return rand() < 0.5 ? { key: 'dot', n: 1, spread: 1500 } : null;
  return rand() < 0.6 ? { key: state.balls >= 102 ? 'tension' : 'chatter', n: 1, spread: 2500 } : null;
}

const fill = (text, s) => text
  .replaceAll('{need}', String(Math.max(0, s.target - s.runs)))
  .replaceAll('{balls}', String(Math.max(0, 120 - s.balls)))
  .replaceAll('{bat}', shortName(s.striker))
  .replaceAll('{bowler}', shortName(s.bowler));

const ROLES = {
  'Jasprit Bumrah': 'fast bowler', 'Hardik Pandya': 'all-rounder and MI captain', 'Rohit Sharma': 'opening batter',
  'Suryakumar Yadav': 'batter', 'Tilak Varma': 'batter who bowls part-time spin', 'Trent Boult': 'left-arm fast bowler',
  'MS Dhoni': 'wicketkeeper-batter', 'Ruturaj Gaikwad': 'opening batter and CSK captain', 'Shivam Dube': 'batting all-rounder',
  'Sanju Samson': 'wicketkeeper-batter', 'Dewald Brevis': 'batter',
};

export const CRICKET = {
  key: 'mi-csk-demo',
  sport: 'cricket',
  sportName: 'cricket',
  title: 'MI v CSK',
  teams: [TEAMS.MI, TEAMS.CSK].map((t) => ({ code: t.code, name: t.name, logo: t.logo })),
  format: 'T20',
  sourceLabel: 'Simulated replay · demo data, not a live feed',
  initial: START,
  items: SCRIPT,
  moments: MOMENTS.map((m) => ({ ...m, index: SCRIPT.findIndex((s) => s.moment === m.id) })).filter((m) => m.index >= 0),
  engine: { initialState, applyItem, snapshot, detectSignals, facts, templatePoll, threadForItem },
  crowd: {
    lines: CROWD,
    fans: makeFans(['MI', 'CSK'], ['sixes', 'yorkers', 'whistles', 'paltan', 'covers', 'thala', 'boom', 'spin', 'chepauk', 'wankhede'], { keep: FANS, seed: 'cricket' }),
    burstFor, fill, otherSide: otherTeam,
    // Cues that react to the latest big moment, so their lines belong in its #thread.
    momentCues: new Set(['bowling_change', 'tilak_hit', 'tilak_wicket', 'bumrah_back', 'drs_appeal', 'drs_result', 'drop',
      'bumrah_wicket', 'dhoni_walks', 'last_over', 'tension', 'csk_win']),
  },
  topics: TOPICS,
  terms: /\b(?:overs?|runs?|wickets?|bowl\w*|bat\w*|score\w*|need\w*|target|rrr|crr|rate|six\w*|fours?|boundar\w*|innings|chase|drs|review|lbw|catch\w*|yorker\w*|spin\w*|partnership|economy|strike|powerplay|wide|no.?ball|free.?hit|dhoni|thala|bumrah|hardik|tilak|dube|gaikwad|ruturaj|brevis|boult|santner|surya\w*|rohit|sanju|mi|csk|match|win\w*|jeet\w*|haar\w*|chahiye|rule\w*)\b/i,
  rules: [
    { topic: 'Overs', text: 'An over is six legal balls from one bowler. A T20 innings has 20 overs per side.' },
    { topic: 'Run rate', text: 'Current run rate (CRR) is runs per over so far. Required run rate (RRR) is the runs still needed divided by the overs left.' },
    { topic: 'Wickets', text: 'A batter is out bowled, caught, LBW, run out or stumped, among others. Losing 10 wickets ends the innings.' },
    { topic: 'LBW', text: 'Leg before wicket: out if the ball hits the batter (usually the pad) and would have gone on to hit the stumps, with conditions on where it pitched and hit.' },
    { topic: 'DRS', text: 'The Decision Review System lets a team challenge an on-field decision. TV replays and ball-tracking decide; on "umpire\'s call" the on-field decision stands.' },
    { topic: 'Boundaries', text: 'A four is the ball reaching the boundary rope along the ground; a six clears the rope without bouncing.' },
    { topic: 'Wides and no-balls', text: 'A wide or no-ball gives the batting side one extra run and the ball must be bowled again. After a front-foot no-ball the next ball is a free hit.' },
    { topic: 'Powerplay', text: 'In the first 6 overs only 2 fielders may stand outside the 30-yard circle, so batters attack early.' },
    { topic: 'Death overs', text: 'The last few overs of an innings, usually overs 16 to 20, when batters take the most risks.' },
    { topic: 'Strategic timeout', text: 'In the IPL each team takes timeouts during an innings to talk tactics.' },
    { topic: 'Result', text: 'The chasing side wins if it passes the target before its overs or wickets run out; otherwise the side batting first wins.' },
  ],
  roster: Object.entries(SQUADS).flatMap(([team, names]) => names.map((name) => ({ name, team, role: ROLES[name] || 'player' })))
    .concat([{ name: 'Mitchell Santner', team: 'MI', role: 'left-arm spinner' }]),
  examples: ['What does RRR mean?', 'What is DRS in cricket?', 'Who is MS Dhoni?'],
};
