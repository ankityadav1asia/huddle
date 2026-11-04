// Simulated fans for public watch parties: scripted lines for each play, seeded by room + run + play so everyone in
// a room sees the same lines at the same moment. Nothing is stored, and they are not chat messages, so they never
// reach the AI Co-host, the message rate limit or moderation queues.
import { one, many, type Queryable } from '../db/index.ts';
import type { MatchEventRow, MatchRow, ModerationLevel } from '../db/rows.ts';
import { fixtureFor, playerFinder, type Fixture } from './fixture.ts';
import { seeded } from './fans.ts';
import { paceOf } from './feed.ts';
import { classify } from '../moderation/classifier.ts';

const WINDOW_SECONDS = 45;
const RECENT_PLAYS = 3; // a player named in this many latest plays is still being talked about

const finders = new Map<string, (text: string) => Set<string>>();
const namesIn = (fixture: Fixture, text: string) => {
  if (!finders.has(fixture.key)) finders.set(fixture.key, playerFinder(fixture));
  return finders.get(fixture.key)!(text);
};

interface CrowdRequest { roomId: string; matchId: string; level?: ModerationLevel }
// One simulated fan's line, as GET /api/rooms/:id/match sends it.
interface CrowdLine { id: string; at: string; fan: string; team: string; text: string; thread: string | null }

// Lines for the plays of the last WINDOW_SECONDS, each with the moment it is due: `at` = when the play happened plus
// its place in the burst, scaled by the game's pace. Lines the room's moderation level would not allow are left out,
// and so are lines about a player who is not in the game right now (see Crowd). Cues that react to the latest big
// moment carry its #thread.
export async function crowdLines(db: Queryable, { roomId, matchId, level = 'balanced' }: CrowdRequest): Promise<CrowdLine[]> {
  const recent = await many<Pick<MatchEventRow, 'seq' | 'occurred_at'>>(db,
    `SELECT seq, occurred_at FROM match_events
      WHERE match_id = $1 AND occurred_at > now() - make_interval(secs => $2) ORDER BY seq`,
    [matchId, WINDOW_SECONDS]);
  if (!recent.length) return [];
  const match = await one<Pick<MatchRow, 'fixture_key' | 'ball_interval_ms'>>(db, 'SELECT fixture_key, ball_interval_ms FROM matches WHERE id = $1', [matchId]);
  const fixture = fixtureFor(match);
  const speed = match ? paceOf(match) : 1;
  const { engine, crowd } = fixture;
  const [sideA, sideB] = fixture.teams.map((t) => t.code);
  const due = new Map(recent.map((r) => [r.seq, new Date(r.occurred_at).getTime()]));
  const lines: CrowdLine[] = [];
  let state = engine.initialState(fixture);
  let moment: string | null = null; // the #thread the latest big moment opened
  const plays: string[] = []; // the texts of the latest RECENT_PLAYS items
  for (let i = 0; i <= recent[recent.length - 1].seq && i < fixture.items.length; i++) {
    state = engine.applyItem(state, fixture.items[i], i).state;
    moment = engine.threadForItem(fixture.items[i])?.slug || moment;
    plays.push(fixture.items[i].text || '');
    if (plays.length > RECENT_PLAYS) plays.shift();
    if (!due.has(i)) continue;
    const rand = seeded(`${roomId}:${matchId}:${i}`);
    const burst = crowd.burstFor(fixture.items[i], state, rand);
    if (!burst) continue;
    const thread = crowd.momentCues.has(burst.key) ? moment : null;
    const said = new Set<string>();
    const inGame = new Set([...namesIn(fixture, plays.join(' ')), ...(crowd.inPlay?.(state) || [])]);
    const synced = (line: string) => crowd.anyoneCues?.has(burst.key) || [...namesIn(fixture, line)].every((name) => inGame.has(name));
    for (let k = 0; k < burst.n; k++) {
      const team = rand() < (burst.share ?? burst.mi ?? 0.5) ? sideA : sideB;
      // Drop lines that @-mention someone: no one in a watch party can be @-mentioned by the crowd.
      const pool = (crowd.lines[burst.key]?.[team] || crowd.lines[burst.key]?.[crowd.otherSide(team)] || []).filter((t) => !said.has(t) && !t.includes('@') && synced(t));
      const fans = crowd.fans.filter((f) => f.team === team);
      const raw = pool[Math.floor(rand() * pool.length)];
      const fan = fans[Math.floor(rand() * fans.length)];
      const offsetMs = ((k / burst.n) * (burst.spread ?? 4000) + rand() * 500) / speed;
      if (!raw || !fan) continue;
      said.add(raw);
      const text = crowd.fill(raw, state);
      if (classify(text, { level }).action !== 'allow') continue;
      lines.push({ id: `${matchId}:${i}:${k}`, at: new Date(due.get(i)! + offsetMs).toISOString(), fan: fan.handle, team, text, thread });
    }
  }
  return lines;
}
