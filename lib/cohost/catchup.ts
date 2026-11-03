// Catch Me Up, for the person who asks only: the match so far (or since they looked away) in stats and key moments,
// and what the room is saying, thread by thread: members' messages (pseudonymised) and, in a public room, the crowd.
// Nothing is posted in the room. Without AI, or when its summary fails validation, it is built from match data alone.
import { one, many, type Db, type Queryable } from '../db/index.ts';
import type { PollRow, RoomEventRow, SignalRow } from '../db/rows.ts';
import type { SessionUser } from '../auth/sessions.ts';
import { HttpError, onlyKeys, clamp, type RequestBody } from '../util.ts';
import { ai } from '../ai/index.ts';
import { SYSTEM, SCHEMAS, buildPrompt, validateOutput, allowedNumbersFrom } from '../ai/tasks.ts';
import { roomAccess } from '../rooms/service.ts';
import { takeToken } from '../limits.ts';
import { cached } from '../ai/context-cache.ts';
import { matchSnapshot } from '../match/feed.ts';
import { crowdLines } from '../match/crowd.ts';
import { matchContext, eventsSince } from './context.ts';

// A poll as Catch Me Up summarises it: counts maps option index to votes, null before the first vote.
type PollSummary = Pick<PollRow, 'question' | 'options' | 'status'> & { counts: Record<string, number> | null };
type Moment = Pick<SignalRow, 'label' | 'priority' | 'fact_text' | 'event_id'>;
interface Stat { label: string; value: string }
interface ThreadTalk { id: string; slug: string; about: string | null; members: number; crowd: number }
interface ThreadPoint { thread: string; id: string; text: string }

// The numbers a fan looks for first, straight from the verified scoreboard. Each sport reads its own snapshot.
export function matchStats(sport: string, sc: any): Stat[] {
  if (!sc) return [];
  if (sport === 'cricket') {
    const out: Stat[] = [{ label: sc.batting, value: `${sc.runs}/${sc.wickets} (${sc.overs} ov)` }];
    if (sc.crr != null) out.push({ label: 'Run rate', value: String(sc.crr) });
    if (sc.target && !sc.result) out.push({ label: 'Need', value: `${sc.need_runs} off ${sc.need_balls}${sc.rrr != null ? ` · RRR ${sc.rrr}` : ''}` });
    if (sc.result) out.push({ label: 'Result', value: sc.result });
    const batted = [...(sc.batters || []), ...(sc.fall_of_wickets || [])]
      .map((b: any) => ({ name: b.short || b.name, runs: b.runs ?? b.r, balls: b.balls ?? b.b, fours: b.fours, sixes: b.sixes }))
      .filter((b) => b.runs != null).sort((a, b) => b.runs - a.runs);
    if (batted[0]) out.push({ label: 'Top score', value: `${batted[0].name} ${batted[0].runs} (${batted[0].balls})` });
    const best = [...(sc.bowling_card || [])].sort((a: any, b: any) => b.wickets - a.wickets || a.economy - b.economy)[0];
    if (best?.wickets) out.push({ label: 'Best bowling', value: `${best.name.split(' ').pop()} ${best.figures}` });
    if (sc.partnership?.balls) out.push({ label: 'Partnership', value: `${sc.partnership.runs} (${sc.partnership.balls})` });
    const boundaries = batted.reduce((n, b) => ({ fours: n.fours + (b.fours || 0), sixes: n.sixes + (b.sixes || 0) }), { fours: 0, sixes: 0 });
    if (boundaries.fours || boundaries.sixes) out.push({ label: 'Boundaries', value: `${boundaries.fours} fours · ${boundaries.sixes} sixes` });
    const last = sc.fall_of_wickets?.at(-1);
    if (last) out.push({ label: 'Last wicket', value: `${last.name.split(' ').pop()} ${last.r} (${last.b})${last.score ? ` at ${last.score}` : ''}` });
    return out;
  }
  const [a, b] = sc.teams || [];
  if (!a || !b) return [];
  const out: Stat[] = [{ label: 'Score', value: `${a.code} ${a.score} – ${b.score} ${b.code}` }];
  if (sport === 'kabaddi') {
    out.push({ label: sc.result ? 'Result' : 'Clock', value: sc.result || `${sc.half === 1 ? 'First' : 'Second'} half, ${sc.clock} left` });
    const raider = sc.raiders?.[0];
    if (raider) out.push({ label: 'Top raider', value: `${raider.short} ${raider.raid_points} pts (${raider.raids} raids)` });
    const defender = sc.defenders?.[0];
    if (defender) out.push({ label: 'Top defender', value: `${defender.short} ${defender.tackle_points} tackle pts` });
    out.push({ label: 'All-out points', value: `${a.all_out_points} – ${b.all_out_points}` });
  } else if (sport === 'football') {
    out.push({ label: sc.result ? 'Result' : 'Minute', value: sc.result || sc.minute });
    const goals = sc.goals || [];
    if (goals.length) out.push({ label: 'Scorers', value: goals.map((g: any) => `${g.scorer.split(' ').pop()} ${g.minute}${g.penalty ? ' (pen)' : ''}`).join(', ') });
    // Card counts per side; red cards by name, since they change the game.
    const booked = (t: any) => [t.yellow && `${t.yellow} yellow`, t.red && `${t.red} red`].filter(Boolean).join(', ') || 'none';
    const reds = (sc.cards || []).filter((c: any) => c.card === 'red').map((c: any) => `${c.player.split(' ').pop()} ${c.minute}`);
    if (a.yellow || a.red || b.yellow || b.red) {
      out.push({ label: 'Cards', value: `${a.code} ${booked(a)} · ${b.code} ${booked(b)}${reds.length ? ` (sent off: ${reds.join(', ')})` : ''}` });
    }
    out.push({ label: 'Shots (on target)', value: `${a.shots} (${a.on_target}) – ${b.shots} (${b.on_target})` });
  } else {
    out.push({ label: sc.result ? 'Result' : 'Clock', value: sc.result || `${sc.period} ${sc.clock}` });
    for (const t of sc.teams) if (t.leaders?.[0]) out.push({ label: `${t.code} leader`, value: `${t.leaders[0].short} ${t.leaders[0].pts} pts` });
  }
  return out;
}

// The latest key moments, oldest first.
async function keyMoments(db: Queryable, matchId: string | null, since: Date | null): Promise<Moment[]> {
  if (!matchId) return [];
  const rows = await many<Moment>(db,
    `SELECT s.label, s.priority, s.fact_text, s.event_id FROM match_signals s JOIN match_events e ON e.id = s.event_id
      WHERE s.match_id = $1 AND s.status IN ('published', 'suppressed') AND s.priority IN ('high', 'medium')
        AND ($2::timestamptz IS NULL OR e.occurred_at > $2::timestamptz)
      ORDER BY e.seq DESC LIMIT 10`, [matchId, since]);
  return rows.reverse();
}

export async function catchUp(db: Db, user: SessionUser, roomId: string, body: RequestBody) {
  onlyKeys(body, ['since_seq', 'scope']);
  const { room } = await roomAccess(db, roomId, user);
  const limited = await takeToken(db, `catchup:${user.id}`, { limit: 4, windowSeconds: 120 });
  if (!limited.ok) throw new HttpError(429, 'rate_limited', 'Give it a moment before catching up again.', { retry_after: limited.retryAfter });
  // scope 'match': the game so far and the room's recent talk. Otherwise since the person looked away (since_seq).
  const wholeMatch = body.scope === 'match';
  const floor = Math.max(0, room.last_seq - 300);
  const sinceSeq = wholeMatch ? floor : Number.isInteger(body.since_seq) ? clamp(body.since_seq, floor, room.last_seq) : Math.max(0, room.last_seq - 40);
  const sinceRow = wholeMatch ? null : await one<Pick<RoomEventRow, 'created_at'>>(db, 'SELECT created_at FROM room_events WHERE room_id = $1 AND seq <= $2 ORDER BY seq DESC LIMIT 1', [roomId, sinceSeq]);
  const since = sinceRow?.created_at || null;

  const snap = room.match_id ? await matchSnapshot(db, room.match_id) : null;
  const stats = snap ? matchStats(snap.match.sport, snap.score) : [];
  const events = (await eventsSince(db, room.match_id, since)).reverse();
  const moments = await keyMoments(db, room.match_id, since);
  const polls = await many<PollSummary>(db,
    `SELECT p.question, p.options, p.status,
            (SELECT jsonb_object_agg(option_index, n) FROM (SELECT option_index, count(*)::int AS n FROM poll_votes v WHERE v.poll_id = p.id GROUP BY option_index) c) AS counts
       FROM polls p WHERE p.room_id = $1 AND p.seq > $2 ORDER BY p.seq DESC LIMIT 3`, [roomId, sinceSeq]);

  // The room's talk: members' messages with their #thread, and the crowd's lines in a public room.
  const rows = await many<{ sender_id: string; body: string; slug: string | null }>(db,
    `SELECT m.sender_id, m.body, t.slug FROM messages m LEFT JOIN room_threads t ON t.id = m.thread_id
      WHERE m.room_id = $1 AND m.sender_type = 'user' AND m.status = 'visible' AND m.seq > $2
      ORDER BY m.seq DESC LIMIT 60`, [roomId, sinceSeq]);
  const alias = new Map<string, string>();
  const messages = rows.reverse().map((r) => {
    if (!alias.has(r.sender_id)) alias.set(r.sender_id, `member${alias.size + 1}`);
    return { from: alias.get(r.sender_id)!, thread: r.slug, text: r.body.slice(0, 300) };
  });
  const crowd = room.room_type === 'public' && room.match_id
    ? (await crowdLines(db, { roomId, matchId: room.match_id })).slice(-40).map((l) => ({ side: l.team, thread: l.thread, text: l.text }))
    : [];
  const threadRows = await many<{ id: string; slug: string; about: string | null }>(db,
    'SELECT id, slug, about FROM room_threads WHERE room_id = $1 ORDER BY last_active_at DESC LIMIT 12', [roomId]);
  const threads: ThreadTalk[] = threadRows.map((t) => ({
    ...t, members: messages.filter((m) => m.thread === t.slug).length, crowd: crowd.filter((c) => c.thread === t.slug).length,
  })).filter((t) => t.members + t.crowd > 0).sort((a, b) => b.members + b.crowd - (a.members + a.crowd));
  const threadId = new Map(threads.map((t) => [t.slug, t.id]));

  // Deterministic summary from verified data: always available, used when AI is off, unavailable or rejected.
  const mc = await matchContext(db, room);
  const people = new Set(messages.map((m) => m.from)).size;
  const fallback = {
    headline: mc.facts?.headline || 'No match data for this room',
    match_points: moments.slice(-4).map((s) => `${s.label}: ${s.fact_text}`.slice(0, 110)),
    thread_points: threads.slice(0, 3).map((t): ThreadPoint => ({
      thread: t.slug, id: t.id,
      text: [t.members ? `${t.members} message${t.members === 1 ? '' : 's'} from members` : '', t.crowd ? `${t.crowd} from the stands` : ''].filter(Boolean).join(', ') + '.',
    })),
    room_points: [
      messages.length ? `${messages.length} message${messages.length === 1 ? '' : 's'} from ${people} member${people === 1 ? '' : 's'}.` : 'No messages from members yet.',
      ...polls.map((p) => {
        const counts: Record<string, number> = p.counts || {};
        const total = Object.values(counts).reduce((x, y) => x + y, 0);
        const lead: [string, number] = p.options.map((o, i): [string, number] => [o.label, counts[i] || 0]).sort((x, y) => y[1] - x[1])[0];
        return total ? `Poll "${p.question}": ${Math.round((lead[1] / total) * 100)}% picked ${lead[0]}.` : `Poll "${p.question}" got no votes yet.`;
      }),
    ].slice(0, 3),
  };
  const base = { scope: wholeMatch ? 'match' : 'since', stats, data_as_of: mc.freshness?.latest_verified_update || null, stale: Boolean(mc.freshness?.stale), source_label: 'Match facts from the match feed' };
  if (!messages.length && !events.length && !crowd.length) return { ...fallback, ...base, source: 'match_data', note: 'Nothing new since you looked away.' };

  const orchestrator = await ai();
  if (!room.ai_enabled || !orchestrator.available) return { ...fallback, ...base, source: 'match_data' };
  const allowedEventIds = new Set<string>([...mc.allowedEventIds, ...events.map((e) => e.event_id), ...moments.map((s) => s.event_id)]);
  const allowedNumbers = new Set<string>([...mc.allowedNumbers, ...allowedNumbersFrom(events.map((e) => e.data), moments, stats)]);
  const result = await cached(roomId, `catchup:${user.id}:${base.scope}:${sinceSeq}:${room.last_seq}`, 20000, () => orchestrator.run({
    task: 'catchup', system: SYSTEM, schema: SCHEMAS.catchup, roomId, userId: user.id, deadline: 14000, timeoutMs: 6000,
    user: buildPrompt('catchup', {
      SCOPE: wholeMatch ? 'the match so far' : 'since the member looked away',
      VERIFIED_MATCH_DATA: mc.facts,
      MATCH_STATS: stats,
      KEY_MOMENTS: moments.map((s) => ({ label: s.label, fact: s.fact_text, event_id: s.event_id })),
      MATCH_EVENTS: events.map((e) => ({ event_id: e.event_id, text: e.data.text || e.data.label || '', at: e.occurred_at })),
      POLLS: polls.map((p) => ({ question: p.question, options: p.options.map((o) => o.label), status: p.status, votes: p.counts || {} })),
      THREADS: threads.map((t) => ({ thread: t.slug, about: t.about, member_messages: t.members, crowd_lines: t.crowd })),
      ROOM_MESSAGES_UNTRUSTED: messages,
      CROWD_CHAT_UNTRUSTED: crowd.length ? crowd : undefined,
      DATA_FRESHNESS: mc.freshness,
    }),
    validate: (v) => validateOutput('catchup', v, { allowedEventIds, allowedNumbers, allowedThreads: new Set(threadId.keys()) }),
  }));
  if (!result.ok) return { ...fallback, ...base, source: 'match_data', note: 'The AI Co-host is unavailable, so this summary comes straight from match data.' };
  const v = result.value;
  return {
    headline: v.headline, match_points: v.match_points, room_points: v.room_points,
    thread_points: v.thread_points.map((p) => ({ thread: p.thread, id: threadId.get(p.thread)!, text: p.text })),
    ...base, source: 'ai', label: 'AI Co-host',
  };
}
