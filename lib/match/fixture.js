// The demo match feed. There is no licensed live cricket provider in this prototype, so the backend replays
// the existing scripted MI v CSK chase (real players, a made-up match) as a timestamped, ball-by-ball feed.
// It is labelled as simulated everywhere it appears. A real provider would replace this module only.
import { START, SCRIPT, MOMENTS, TEAMS } from '../../public/src/data.js';

export const DEMO_FIXTURE = {
  key: 'mi-csk-demo',
  title: 'MI v CSK',
  teams: [TEAMS.MI, TEAMS.CSK].map((t) => ({ code: t.code, name: t.name, logo: t.logo })),
  format: 'T20',
  sourceLabel: 'Simulated replay · demo data, not a live feed',
  initial: START,
  items: SCRIPT,
  moments: MOMENTS.map((m) => ({ ...m, index: SCRIPT.findIndex((s) => s.moment === m.id) })).filter((m) => m.index >= 0),
};

export const FIXTURES = { [DEMO_FIXTURE.key]: DEMO_FIXTURE };

export function fixtureFor(match) {
  return FIXTURES[match.fixture_key] || DEMO_FIXTURE;
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
