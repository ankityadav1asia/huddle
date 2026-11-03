// Match Momentum Engine, stage 1: deterministic rules over verified, structured feed data.
// The LLM never decides that a wicket happened; it may only explain a signal these rules produced.
// Thresholds below are demo heuristics for a T20 chase, not universal cricket truths.
import { oversText, rates, shortName } from './scorecard.ts';

export const RULES = {
  wicket_fallen: { priority: 'high', label: 'Big wicket' },
  partnership_break: { priority: 'high', label: 'Partnership broken' },
  match_result_confirmed: { priority: 'high', label: 'Result' },
  dropped_catch: { priority: 'medium', label: 'Momentum shift' },
  required_run_rate_spike: { priority: 'medium', label: 'Run-rate pressure' },
  boundary_burst: { priority: 'low', label: 'Boundary burst' },
  dot_ball_pressure: { priority: 'low', label: 'Pressure building' },
  death_overs_started: { priority: 'low', label: 'Death overs' },
  review_outcome: { priority: 'low', label: 'Game on' },
};

export const THRESHOLDS = {
  partnershipBreakRuns: 30, // a wicket that ends a stand this big (counted from feed start) is a partnership break
  boundaryBurst: { boundaries: 2, withinLegalBalls: 4 },
  dotPressure: 3, // consecutive dot balls
  rrrSpike: { minRate: 9, rise: 1.5, overLegalBalls: 6 },
  deathOversFromBall: 90, // over 16 onwards
};

const PRIORITY_RANK = { high: 3, medium: 2, low: 1 };
export const rank = (p) => PRIORITY_RANK[p] || 0;

function scoreLine(s) {
  return `${s.batting} ${s.runs}/${s.wkts} (${oversText(s.balls)})`;
}

function needLine(s) {
  const r = rates(s);
  return r.need_runs > 0 ? `need ${r.need_runs} off ${r.need_balls}` : `${s.batting} have reached the target`;
}

function signal(trigger, evidence, factText, dedupe) {
  return { trigger, ...RULES[trigger], evidence, fact_text: factText, dedupe };
}

// prev/next: scorecard states around one feed item. Returns zero or more signals for that item.
export function detectSignals(prev, next, item, ball) {
  const out: any[] = [];
  const overNo = Math.floor(prev.balls / 6) + 1;
  if (item.kind === 'event') {
    if (item.type === 'result') {
      out.push(signal('match_result_confirmed', { result: item.text, score: scoreLine(next) },
        `${item.text} Final score ${scoreLine(next)}.`, 'result'));
    } else if (item.type === 'review') {
      out.push(signal('review_outcome', { text: item.text, score: scoreLine(next) },
        `DRS: ${item.text}`, `review:${next.last_seq}`));
    }
    return out;
  }
  if (item.kind !== 'ball' || !ball) return out;

  if (ball.wicket) {
    const stand = ball.wicket.partnership.runs;
    const trigger = stand >= THRESHOLDS.partnershipBreakRuns ? 'partnership_break' : 'wicket_fallen';
    const w = ball.wicket;
    const standText = trigger === 'partnership_break' ? ` Ends a ${stand}-run stand.` : '';
    out.push(signal(trigger, {
      out: w.name, how: w.how, runs: w.r, balls: w.b, bowler: ball.bowler, over: ball.label,
      score: scoreLine(next), partnership_runs: stand, ...rates(next),
    }, `${w.name} ${w.how}, ${w.r} (${w.b}).${standText} ${scoreLine(next)}, ${needLine(next)}.`, `wicket:${ball.seq}`));
  }
  if (ball.drop) {
    out.push(signal('dropped_catch', { dropped_by: ball.drop.by, batter: ball.bat, bowler: ball.bowler, over: ball.label, score: scoreLine(next) },
      `DROPPED: ${ball.drop.by} drops ${ball.bat} off ${shortName(ball.bowler)}. ${scoreLine(next)}, ${needLine(next)}.`, `drop:${ball.seq}`));
  }
  const legal = next.ball_log.filter((b) => b.legal);
  if (ball.boundary) {
    const window = legal.slice(-THRESHOLDS.boundaryBurst.withinLegalBalls);
    const hits = window.filter((b) => b.boundary);
    if (hits.length >= THRESHOLDS.boundaryBurst.boundaries) {
      out.push(signal('boundary_burst', { balls: window.map((b) => `${b.label}:${b.symbol}`), runs: window.reduce((a, b) => a + b.runs, 0), score: scoreLine(next) },
        `${hits.length} boundaries in the last ${window.length} balls (${window.map((b) => b.symbol).join(' ')}). ${scoreLine(next)}, ${needLine(next)}.`,
        `burst:over${overNo}`));
    }
  }
  if (ball.dot) {
    const lastN = legal.slice(-THRESHOLDS.dotPressure);
    if (lastN.length === THRESHOLDS.dotPressure && lastN.every((b) => b.dot)) {
      out.push(signal('dot_ball_pressure', { balls: lastN.map((b) => b.label), score: scoreLine(next), ...rates(next) },
        `${THRESHOLDS.dotPressure} dot balls in a row. ${scoreLine(next)}, ${needLine(next)}.`, `dots:over${overNo}`));
    }
  }
  if (ball.legal && prev.balls === THRESHOLDS.deathOversFromBall) {
    out.push(signal('death_overs_started', { over: overNo, score: scoreLine(next), ...rates(prev) },
      `Over ${overNo} has started: ${prev.batting} ${needLine(prev)} (${prev.runs}/${prev.wkts} after ${Math.floor(prev.balls / 6)} overs).`, 'death_overs'));
  }
  if (ball.legal) {
    const { minRate, rise, overLegalBalls } = THRESHOLDS.rrrSpike;
    const now = next.rrr_log.at(-1);
    const before = next.rrr_log.at(-1 - overLegalBalls);
    if (now != null && before != null && now >= minRate && now - before >= rise) {
      out.push(signal('required_run_rate_spike', { rrr_now: now, rrr_before: before, legal_balls: overLegalBalls, score: scoreLine(next), ...rates(next) },
        `Required rate up to ${now.toFixed(2)} an over, from ${before.toFixed(2)} six balls ago. ${scoreLine(next)}, ${needLine(next)}.`,
        `rrr:over${overNo}`));
    }
  }
  return out;
}
