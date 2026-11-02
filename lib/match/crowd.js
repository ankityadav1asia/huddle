// The simulated fans, inside the public watch party: scripted fan lines (Hinglish and English) for each play of the
// simulated game, from that sport's crowd of CROWD_SIZE personas. They are derived from the match feed with a
// seeded random generator (room + run + play), so everyone in the room sees the same simulated fans say the same
// thing at the same moment, and nothing is stored. The UI labels them as simulated fans; they are not chat
// messages, so they never reach the AI Co-host, the message rate limit or moderation queues. Private rooms do not
// get them: only the people invited are there.
import { one, many } from '../db/index.js';
import { fixtureFor } from './fixture.js';
import { seeded } from './fans.js';
import { classify } from '../moderation/classifier.js';

const WINDOW_SECONDS = 45;

// Lines for the plays of the last WINDOW_SECONDS (plays skipped by a jump get none), each with the moment it is
// due: `at` = when the play happened plus its place in the burst, scaled by the replay speed. Lines the room's
// moderation level would not allow are left out. Cues that react to the latest big moment carry its #thread.
export async function crowdLines(db, { roomId, matchId, speed = 1, level = 'balanced' }) {
  const recent = await many(db,
    `SELECT seq, occurred_at FROM match_events
      WHERE match_id = $1 AND NOT backfilled AND occurred_at > now() - make_interval(secs => $2) ORDER BY seq`,
    [matchId, WINDOW_SECONDS]);
  if (!recent.length) return [];
  const fixture = fixtureFor(await one(db, 'SELECT fixture_key FROM matches WHERE id = $1', [matchId]) || {});
  const { engine, crowd } = fixture;
  const [sideA, sideB] = fixture.teams.map((t) => t.code);
  const due = new Map(recent.map((r) => [r.seq, new Date(r.occurred_at).getTime()]));
  const lines = [];
  let state = engine.initialState(fixture);
  let moment = null; // the #thread the latest big moment opened
  for (let i = 0; i <= recent[recent.length - 1].seq && i < fixture.items.length; i++) {
    state = engine.applyItem(state, fixture.items[i], i).state;
    moment = engine.threadForItem(fixture.items[i])?.slug || moment;
    if (!due.has(i)) continue;
    const rand = seeded(`${roomId}:${matchId}:${i}`);
    const burst = crowd.burstFor(fixture.items[i], state, rand);
    if (!burst) continue;
    const thread = crowd.momentCues.has(burst.key) ? moment : null;
    const said = new Set();
    for (let k = 0; k < burst.n; k++) {
      const team = rand() < (burst.share ?? burst.mi ?? 0.5) ? sideA : sideB;
      // Lines that @-mention someone were written for the old demo's creator-host, who is not in a watch party.
      const pool = (crowd.lines[burst.key]?.[team] || crowd.lines[burst.key]?.[crowd.otherSide(team)] || []).filter((t) => !said.has(t) && !t.includes('@'));
      const fans = crowd.fans.filter((f) => f.team === team);
      const raw = pool[Math.floor(rand() * pool.length)];
      const fan = fans[Math.floor(rand() * fans.length)];
      const offsetMs = ((k / burst.n) * (burst.spread ?? 4000) + rand() * 500) / speed;
      if (!raw || !fan) continue;
      said.add(raw);
      const text = crowd.fill(raw, state);
      if (classify(text, { level }).action !== 'allow') continue;
      lines.push({ id: `${matchId}:${i}:${k}`, at: new Date(due.get(i) + offsetMs).toISOString(), fan: fan.handle, team, text, thread });
    }
  }
  return lines;
}
