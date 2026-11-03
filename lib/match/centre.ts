// The Match Centre's full view of a run (GET /api/rooms/:id/match?detail=1): every play, newest first, with its over or
// clock, the sport's graphs, its stats and the win predictor (insights.ts). Rebuilt from the run's ingested events with
// the sport's engine, the same way the scoreboard is; a run has fewer than 100 items, so replaying it on each request
// is cheap.
import { many, type Queryable } from '../db/index.ts';
import type { MatchEventRow, MatchRow } from '../db/rows.ts';
import { fixtureFor } from './fixture.ts';
import { matchInsights } from './insights.ts';

const MAX_COMMENTARY = 300;

interface Play {
  event_id: string;
  kind: string;
  over: string;
  symbol: string | null;
  label: string | null;
  text: string;
  occurred_at: Date;
}

export async function matchCentre(db: Queryable, match: Pick<MatchRow, 'id' | 'fixture_key'>) {
  const fixture = fixtureFor(match);
  const { engine } = fixture;
  const events = await many<Pick<MatchEventRow, 'id' | 'seq' | 'kind' | 'data' | 'occurred_at'>>(db,
    'SELECT id, seq, kind, data, occurred_at FROM match_events WHERE match_id = $1 ORDER BY seq', [match.id]);
  let state = engine.initialState(fixture);
  const states = [state];
  const balls: unknown[] = [];
  const plays: Play[] = [];
  for (const e of events) {
    const item = fixture.items[e.seq];
    const { state: next, ball } = engine.applyItem(state, item, e.seq);
    const line = engine.describe(item, state, next, ball);
    plays.push({
      event_id: e.id, kind: e.kind, over: line.over, symbol: line.symbol,
      label: line.label || e.data.label || null, text: line.text || e.data.text || '', occurred_at: e.occurred_at,
    });
    states.push(next);
    balls.push(ball);
    state = next;
  }
  const insights = matchInsights(fixture, states, plays.map((p) => p.over), balls);
  return { commentary: plays.reverse().slice(0, MAX_COMMENTARY), graphs: engine.graphs(states), ...insights };
}
