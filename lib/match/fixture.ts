// The demo fixtures: one scripted, simulated game per sport (cricket, F1, basketball, hockey). There is no licensed
// live data provider in this prototype, so the backend replays these as timestamped feeds, labelled as simulated
// everywhere they appear. A real provider would replace these modules only. Each fixture brings its own engine
// (state, scoreboard, big moments, threads, AI facts), simulated fans, rules sheet and roster.
import { one, type Queryable } from '../db/index.ts';
import type { MatchRow, Priority } from '../db/rows.ts';
import type { Fan } from './fans.ts';
import { CRICKET } from './sports/cricket.ts';
import { F1 } from './sports/f1.ts';
import { BASKETBALL } from './sports/basketball.ts';
import { HOCKEY } from './sports/hockey.ts';

export interface Team { code: string; name: string; logo?: string }
// A named point in the script that a replay can jump to; `index` is the script item it starts at.
export interface Moment { id: string; label: string; index: number }
// The #thread a big moment opens in every room following the match.
export interface MomentThread { slug: string; about: string; keywords: string[] }
export interface Topic { slug: string; keywords: string[] }
export interface Rule { topic: string; text: string }
export interface RosterEntry { name: string; team: string; role: string }
export interface BackedPlayer { name: string; short: string; team: string }
export interface PollTemplate { question: string; options: string[] }
// A burst of simulated fan lines: `n` lines of cue `key` over `spread` ms. `share` (cricket's script says `mi`) is
// the chance that each line comes from the first side's fans.
export interface CrowdCue { key: string; n: number; spread?: number; share?: number; mi?: number }
// Simulated fan lines by cue, then by side (team code).
export type CrowdLines = Record<string, Record<string, string[]>>;

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
// What the AI may state about the game, built from the verified snapshot only. Every sport leads with a headline.
export interface Facts { headline: string; [field: string]: unknown }

// Replays a sport's script. `ball` is what an item was, for engines whose rules read it (cricket's delivery), else null.
export interface Engine<State, Item, Score> {
  initialState(fixture: Fixture<State, Item, Score>): State;
  applyItem(state: State, item: Item, seq: number): { state: State; ball: unknown };
  snapshot(state: State): Score;
  detectSignals(prev: State, next: State, item: Item, ball: unknown, seq: number): Signal[];
  facts(snap: FactsInput<Score>): Facts;
  templatePoll(state: State): PollTemplate;
  threadForItem(item: Item): MomentThread | null;
}

export interface Crowd<State, Item> {
  lines: CrowdLines;
  fans: Fan[];
  burstFor(item: Item, state: State, rand: () => number): CrowdCue | null;
  fill(text: string, state: State): string;
  otherSide(team: string): string;
  momentCues: Set<string>;
}

// A sport's simulated game: its script, the engine that replays it, its crowd, and the help shown to newcomers.
// Engine state, script items and scoreboards differ per sport: each sports/*.ts file types its own, and code that
// serves every sport (feed, crowd, replay, co-host) sees them as `any` through the defaults.
export interface Fixture<State = any, Item = any, Score = any> {
  key: string;
  sport: string;
  sportName: string;
  title: string;
  teams: Team[];
  format: string;
  sourceLabel: string;
  items: Item[];
  moments: Moment[];
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
export interface SportBacking { sport: string; label: string; title: string; teams: Team[]; players: BackedPlayer[] }

export const DEMO_FIXTURE = CRICKET;
export const FIXTURE_ORDER: Fixture[] = [CRICKET, F1, BASKETBALL, HOCKEY];
export const FIXTURES: Record<string, Fixture> = Object.fromEntries(FIXTURE_ORDER.map((f) => [f.key, f]));
export const sportRank = (fixtureKey: string) => FIXTURE_ORDER.findIndex((f) => f.key === fixtureKey);
// What a fan can back in each sport (a team and up to three players), in home-screen order. One fixture per sport.
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

// What the replay clock reads from a script item: its kind, and how long to dwell on it (ms).
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
