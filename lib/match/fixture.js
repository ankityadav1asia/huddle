// The demo fixtures: one scripted, simulated game per sport (cricket, F1, basketball, hockey). There is no licensed
// live data provider in this prototype, so the backend replays these as timestamped feeds, labelled as simulated
// everywhere they appear. A real provider would replace these modules only. Each fixture brings its own engine
// (state, scoreboard, big moments, threads, AI facts), simulated fans, rules sheet and roster.
import { one } from '../db/index.js';
import { CRICKET } from './sports/cricket.js';
import { F1 } from './sports/f1.js';
import { BASKETBALL } from './sports/basketball.js';
import { HOCKEY } from './sports/hockey.js';

export const DEMO_FIXTURE = CRICKET;
export const FIXTURE_ORDER = [CRICKET, F1, BASKETBALL, HOCKEY];
export const FIXTURES = Object.fromEntries(FIXTURE_ORDER.map((f) => [f.key, f]));
export const sportRank = (fixtureKey) => FIXTURE_ORDER.findIndex((f) => f.key === fixtureKey);

export function fixtureFor(match) {
  return FIXTURES[match?.fixture_key] || DEMO_FIXTURE;
}

export async function fixtureForMatch(q, matchId) {
  if (!matchId) return null;
  const m = await one(q, 'SELECT fixture_key FROM matches WHERE id = $1', [matchId]);
  return m ? fixtureFor(m) : null;
}

// Seconds after feed start at which each item is published. Deterministic, so every server instance agrees.
export function schedule(fixture, ballSeconds) {
  const offsets = [];
  let t = 2;
  for (const item of fixture.items) {
    offsets.push(t);
    const gap = item.kind === 'overend' ? 0.6 : item.kind === 'event' ? 0.8 : 1;
    t += ballSeconds * gap + (item.pause ? Math.min(item.pause / 1000, 4) * 0.5 : 0);
  }
  return offsets;
}

export const providerEventId = (fixture, index) => `${fixture.key}:${index}`;
