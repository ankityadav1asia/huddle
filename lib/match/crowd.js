// The scripted crowd from the original single-viewer demo, now inside the watch party: Hinglish fan lines for each
// ball and event of the simulated replay. They are derived from the match feed with a seeded random generator
// (room + run + ball), so everyone in a room sees the same simulated fans say the same thing at the same moment,
// and nothing is stored. The UI labels them as simulated fans; they are not chat messages, so they never reach the
// AI Co-host, the 30-second rule or moderation queues.
import { one, many } from '../db/index.js';
import { CROWD, FANS, otherTeam, shortName } from './demo-script.js';
import { fixtureFor } from './fixture.js';
import { initialState, applyItem } from './scorecard.js';
import { classify } from '../moderation/classifier.js';

const WINDOW_SECONDS = 45;

// FNV-1a over the seed, then mulberry32: the same sequence on every server instance.
function rng(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The script's own crowd cue for an item, or the background chatter the demo played between cues.
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

// Lines for the balls of the last WINDOW_SECONDS (balls skipped by a jump get none), each with the moment it is
// due: `at` = when the ball happened plus its place in the burst, scaled by the replay speed. Lines the room's
// moderation level would not allow are left out.
export async function crowdLines(db, { roomId, matchId, speed = 1, level = 'balanced' }) {
  const recent = await many(db,
    `SELECT seq, occurred_at FROM match_events
      WHERE match_id = $1 AND NOT backfilled AND occurred_at > now() - make_interval(secs => $2) ORDER BY seq`,
    [matchId, WINDOW_SECONDS]);
  if (!recent.length) return [];
  const fixture = fixtureFor(await one(db, 'SELECT fixture_key FROM matches WHERE id = $1', [matchId]) || {});
  const due = new Map(recent.map((r) => [r.seq, new Date(r.occurred_at).getTime()]));
  const lines = [];
  let state = initialState(fixture);
  for (let i = 0; i <= recent[recent.length - 1].seq && i < fixture.items.length; i++) {
    state = applyItem(state, fixture.items[i], i).state;
    if (!due.has(i)) continue;
    const rand = rng(`${roomId}:${matchId}:${i}`);
    const burst = burstFor(fixture.items[i], state, rand);
    if (!burst) continue;
    const said = new Set();
    for (let k = 0; k < burst.n; k++) {
      const team = rand() < (burst.mi ?? 0.5) ? 'MI' : 'CSK';
      // Lines that @-mention someone were written for the old demo's creator-host, who is not in a watch party.
      const pool = (CROWD[burst.key]?.[team] || CROWD[burst.key]?.[otherTeam(team)] || []).filter((t) => !said.has(t) && !t.includes('@'));
      const fans = FANS.filter((f) => f.team === team);
      const raw = pool[Math.floor(rand() * pool.length)];
      const fan = fans[Math.floor(rand() * fans.length)];
      const offsetMs = ((k / burst.n) * (burst.spread ?? 4000) + rand() * 500) / speed;
      if (!raw || !fan) continue;
      said.add(raw);
      const text = fill(raw, state);
      if (classify(text, { level }).action !== 'allow') continue;
      lines.push({ id: `${matchId}:${i}:${k}`, at: new Date(due.get(i) + offsetMs).toISOString(), fan: fan.handle, team, text });
    }
  }
  return lines;
}
