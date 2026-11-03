// The demo fixtures: one scripted, simulated game per sport (cricket, F1, basketball, hockey). There is no licensed
// live data provider in this prototype, so the backend replays these as timestamped feeds, labelled as simulated
// everywhere they appear. A real provider would replace these modules only. Each fixture brings its own engine
// (state, scoreboard, big moments, threads, AI facts), simulated fans, rules sheet and roster.
import { one, type Queryable } from '../db/index.ts';
import { CRICKET } from './sports/cricket.ts';
import { F1 } from './sports/f1.ts';
import { BASKETBALL } from './sports/basketball.ts';
import { HOCKEY } from './sports/hockey.ts';

// A sport's simulated game: its script, the engine that replays it, its crowd, and the help shown to newcomers.
// Scripts and engine states differ per sport, so they stay untyped here; each sport file owns their shape.
export interface Fixture {
  key: string;
  sport: string;
  sportName: string;
  title: string;
  teams: { code: string; name: string; logo?: string }[];
  format: string;
  sourceLabel: string;
  items: any[];
  moments: { id: string; label: string; index: number }[];
  engine: {
    initialState(fixture?: Fixture): any;
    applyItem(state: any, item: any, seq: number): { state: any; ball?: any };
    snapshot(state: any): any;
    detectSignals(prev: any, next: any, item: any, ball: any, seq: number): any[];
    facts(snap: any): any;
    templatePoll(state: any): { question: string; options: string[] };
    threadForItem(item: any): { slug: string; about: string; keywords: string[] } | null;
  };
  crowd: {
    lines: Record<string, any>;
    fans: { handle: string; team: string }[];
    burstFor(item: any, state: any, rand: () => number): any;
    fill(text: string, state: any): string;
    otherSide(team: string): string;
    momentCues: Set<string>;
  };
  topics: { slug: string; keywords: string[] }[];
  terms: RegExp;
  rules: { topic: string; text: string }[];
  roster: { name: string; team: string; role: string }[];
  examples: string[];
  backing: { teams: { code: string; name: string; logo?: string }[]; players: { name: string; short: string; team: string }[] };
}

export const DEMO_FIXTURE: Fixture = CRICKET;
export const FIXTURE_ORDER: Fixture[] = [CRICKET, F1, BASKETBALL, HOCKEY];
export const FIXTURES: Record<string, Fixture> = Object.fromEntries(FIXTURE_ORDER.map((f) => [f.key, f]));
export const sportRank = (fixtureKey) => FIXTURE_ORDER.findIndex((f) => f.key === fixtureKey);
// What a fan can back in each sport (a team and up to three players), in home-screen order. One fixture per sport.
export const SPORTS = Object.fromEntries(FIXTURE_ORDER.map((f) => [f.sport, {
  sport: f.sport, label: `${f.sportName[0].toUpperCase()}${f.sportName.slice(1)}`, title: f.title, ...f.backing,
}]));

export function fixtureFor(match: { fixture_key?: string } | null | undefined): Fixture {
  return FIXTURES[match?.fixture_key ?? ''] || DEMO_FIXTURE;
}

export async function fixtureForMatch(q: Queryable, matchId: string | null | undefined): Promise<Fixture | null> {
  if (!matchId) return null;
  const m = await one(q, 'SELECT fixture_key FROM matches WHERE id = $1', [matchId]);
  return m ? fixtureFor(m) : null;
}

// Seconds after feed start at which each item is published. Deterministic, so every server instance agrees.
export function schedule(fixture: Fixture, ballSeconds: number): number[] {
  const offsets: number[] = [];
  let t = 2;
  for (const item of fixture.items) {
    offsets.push(t);
    const gap = item.kind === 'overend' ? 0.6 : item.kind === 'event' ? 0.8 : 1;
    t += ballSeconds * gap + (item.pause ? Math.min(item.pause / 1000, 4) * 0.5 : 0);
  }
  return offsets;
}

export const providerEventId = (fixture, index) => `${fixture.key}:${index}`;
