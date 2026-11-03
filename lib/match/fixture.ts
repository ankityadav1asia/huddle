// One scripted game per sport (fixture data: real names, made-up games). With no licensed live data provider, the
// backend plays these as timestamped feeds; a real provider would replace only these modules.
import { one, type Queryable } from '../db/index.ts';
import type { MatchRow, Priority } from '../db/rows.ts';
import type { Fan } from './fans.ts';
import { CRICKET } from './sports/cricket.ts';
import { FOOTBALL } from './sports/football.ts';
import { BASKETBALL } from './sports/basketball.ts';

export interface Team { code: string; name: string; logo?: string }
// The #thread a big moment opens in every room following the match.
export interface MomentThread { slug: string; about: string; keywords: string[] }
export interface Topic { slug: string; keywords: string[] }
interface Rule { topic: string; text: string }
export interface RosterEntry { name: string; team: string; role: string }
interface BackedPlayer { name: string; short: string; team: string }
export interface PollTemplate { question: string; options: string[] }
// A burst of simulated fan lines: `n` lines of cue `key` over `spread` ms. `share` (cricket's script says `mi`) is
// the chance that each line comes from the first side's fans.
export interface CrowdCue { key: string; n: number; spread?: number; share?: number; mi?: number }
// Simulated fan lines by cue, then by side (team code).
type CrowdLines = Record<string, Record<string, string[]>>;

// A moment card for one feed item, raised by cricket's rules (momentum.ts) or marked in a scripted sport's script.
export interface Signal {
  trigger: string;
  priority: Priority;
  label: string;
  evidence: Record<string, unknown>;
  fact_text: string;
  dedupe: string;
}

// What facts() reads: the match header and that sport's scoreboard (see matchSnapshot and the co-host context).
export interface FactsInput<Score> {
  match: { title: string; format: string; status: string; source: string; source_label: string };
  score: Score;
}
// What the AI may state about the game, built from the verified snapshot only.
interface Facts { headline: string; [field: string]: unknown }

// A played item as the Match Centre lists it: cricket's over.ball (or the overs bowled, for an event) or the game
// clock, and a ball's symbol. label and text stand in for items the feed gives none (cricket's end of over).
export interface PlayLabel { over: string; symbol: string | null; label?: string; text?: string }

// The Match Centre's graphs (GET /api/rooms/:id/match?detail=1). Cricket: each over of the feed with its runs,
// wickets and the innings total at its end. Kabaddi, football and basketball: the score (a for teams[0], b for
// teams[1]) at the start, after each change and now.
export type Graphs =
  | { kind: 'cricket'; target: number | null; overs: { over: number; runs: number; wickets: number; total: number }[] }
  | { kind: 'score'; teams: string[]; points: { label: string; a: number; b: number }[] };

// `ball` is what an item was, for engines whose rules read it (cricket's delivery), else null.
interface Engine<State, Item, Score> {
  initialState(fixture: Fixture<State, Item, Score>): State;
  applyItem(state: State, item: Item, seq: number): { state: State; ball: unknown };
  snapshot(state: State): Score;
  detectSignals(prev: State, next: State, item: Item, ball: unknown, seq: number): Signal[];
  facts(snap: FactsInput<Score>): Facts;
  templatePoll(state: State): PollTemplate;
  threadForItem(item: Item): MomentThread | null;
  describe(item: Item, prev: State, next: State, ball: unknown): PlayLabel;
  // states: the game before the run's first item, then after each item played since.
  graphs(states: State[]): Graphs;
}

interface Crowd<State, Item> {
  lines: CrowdLines;
  fans: Fan[];
  burstFor(item: Item, state: State, rand: () => number): CrowdCue | null;
  fill(text: string, state: State): string;
  otherSide(team: string): string;
  momentCues: Set<string>;
}

// A sport's scripted game. Each sports/*.ts file types its own state, items and scoreboard; code that serves every
// sport (feed, crowd, Match Centre, co-host) sees them as `any` through the defaults.
export interface Fixture<State = any, Item = any, Score = any> {
  key: string;
  sport: string;
  sportName: string;
  title: string;
  teams: Team[];
  format: string;
  sourceLabel: string;
  items: Item[];
  engine: Engine<State, Item, Score>;
  crowd: Crowd<State, Item>;
  topics: Topic[];
  terms: RegExp;
  rules: Rule[];
  roster: RosterEntry[];
  examples: string[];
  backing: { teams: Team[]; players: BackedPlayer[] };
}

// What a fan can back in one sport, as GET /api/config lists it.
interface SportBacking { sport: string; label: string; title: string; teams: Team[]; players: BackedPlayer[] }

export const DEMO_FIXTURE = CRICKET;
export const FIXTURE_ORDER: Fixture[] = [CRICKET, FOOTBALL, BASKETBALL];
export const FIXTURES: Record<string, Fixture> = Object.fromEntries(FIXTURE_ORDER.map((f) => [f.key, f]));
export const sportRank = (fixtureKey: string) => FIXTURE_ORDER.findIndex((f) => f.key === fixtureKey);
// Backing per sport, in home-screen order (one fixture per sport).
export const SPORTS: Record<string, SportBacking> = Object.fromEntries(FIXTURE_ORDER.map((f) => [f.sport, {
  sport: f.sport, label: `${f.sportName[0].toUpperCase()}${f.sportName.slice(1)}`, title: f.title, ...f.backing,
}]));

export function fixtureFor(match: { fixture_key?: string } | null | undefined): Fixture {
  return FIXTURES[match?.fixture_key ?? ''] || DEMO_FIXTURE;
}

export async function fixtureForMatch(q: Queryable, matchId: string | null | undefined): Promise<Fixture | null> {
  if (!matchId) return null;
  const m = await one<Pick<MatchRow, 'fixture_key'>>(q, 'SELECT fixture_key FROM matches WHERE id = $1', [matchId]);
  return m ? fixtureFor(m) : null;
}

// What the feed clock reads from a script item: its kind, and how long to dwell on it (ms).
interface Paced { kind: string; pause?: number }

// Seconds after feed start at which each item is published. Deterministic, so every server instance agrees.
export function schedule(fixture: { items: Paced[] }, ballSeconds: number): number[] {
  const offsets: number[] = [];
  let t = 2;
  for (const item of fixture.items) {
    offsets.push(t);
    const gap = item.kind === 'overend' ? 0.6 : item.kind === 'event' ? 0.8 : 1;
    t += ballSeconds * gap + (item.pause ? Math.min(item.pause / 1000, 4) * 0.5 : 0);
  }
  return offsets;
}

export const providerEventId = (fixture: Fixture, index: number) => `${fixture.key}:${index}`;
