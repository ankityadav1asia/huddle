// Score keeping for the replay: applies one delivery at a time and summarises the state for the AI.
import { START, TEAMS, shortName } from './data.js';

export function newMatch() {
  const m = structuredClone(START);
  m.thisOver = [];
  m.recent = [];
  return m;
}

export const oversText = (balls) => `${Math.floor(balls / 6)}.${balls % 6}`;

export function figures({ b, r, w }) {
  const overs = b % 6 ? `${Math.floor(b / 6)}.${b % 6}` : `${b / 6}`;
  return `${overs}-0-${r}-${w}`;
}

const symbolFor = (item) => {
  if (item.wicket) return 'W';
  if (item.extra === 'wd') return 'wd';
  return String(item.runs);
};

export function applyBall(m, item) {
  const legal = !item.extra;
  // A new over starts on the first delivery after six legal balls.
  if (m.thisOver.length && m.thisOver.filter((s) => s !== 'wd').length === 6) m.thisOver = [];
  // Cricket notation: the 16th over is 15.1 to 15.6. A wide carries the number of the ball still to come.
  const label = `${Math.floor(m.balls / 6)}.${(m.balls % 6) + 1}`;

  m.runs += item.runs;
  const bowler = (m.bowlers[item.bowler] ||= { b: 0, r: 0, w: 0 });
  bowler.r += item.runs;
  const bat = (m.batters[item.bat] ||= { r: 0, b: 0 });
  if (legal) {
    m.balls += 1;
    bowler.b += 1;
    bat.r += item.runs;
    bat.b += 1;
  }
  if (item.wicket) {
    m.wkts += 1;
    bowler.w += 1;
    const out = m.batters[item.wicket.out];
    m.outs.push({ name: item.wicket.out, r: out.r, b: out.b, how: item.wicket.how });
    delete m.batters[item.wicket.out];
    m.batters[item.wicket.next] = { r: 0, b: 0 };
  }
  const symbol = symbolFor(item);
  m.thisOver.push(symbol);
  m.bowler = item.bowler;
  m.striker = item.wicket ? item.wicket.next : item.bat;
  m.recent.push(`${label} ${item.text}`);
  if (m.recent.length > 8) m.recent.shift();
  return { label, symbol };
}

export function need(m) {
  return { runs: Math.max(0, m.target - m.runs), balls: 120 - m.balls };
}

export function summary(m) {
  const n = need(m);
  return {
    batting: TEAMS[m.batting].name,
    bowling: TEAMS[m.bowling].name,
    batting_code: m.batting,
    bowling_code: m.bowling,
    current_bowler: m.bowler,
    score: `${m.batting} ${m.runs}/${m.wkts}`,
    overs: oversText(m.balls),
    target: m.target,
    need_runs: n.runs,
    balls_left: n.balls,
    required_rate: n.balls ? (n.runs / (n.balls / 6)).toFixed(2) : '-',
    first_innings: m.firstInnings,
    batters: Object.entries(m.batters).map(([name, s]) => `${name} ${s.r} (${s.b})${name === m.striker ? '*' : ''}`),
    bowler: `${m.bowler} ${figures(m.bowlers[m.bowler] || { b: 0, r: 0, w: 0 })}`,
    bowling_figures: Object.entries(m.bowlers).filter(([, s]) => s.b).map(([name, s]) => `${name} ${figures(s)}`),
    dismissed: m.outs.map((o) => `${o.name} ${o.r} (${o.b}) ${o.how}`),
    this_over: m.thisOver.join(' '),
    recent_balls: m.recent,
  };
}

export const batterLine = (m) => Object.entries(m.batters)
  .map(([name, s]) => `${shortName(name)}${name === m.striker ? '*' : ''} ${s.r} (${s.b})`)
  .join('  ·  ');
