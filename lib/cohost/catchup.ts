// Catch Me Up, for the person who asks only: what they missed while away (or the match so far). The score then and
// now, what changed, the plays that mattered, and what the room said on each #thread and in its polls (members'
// messages pseudonymised; in a public room, the crowd). Nothing here repeats the scorecard except the one "now" line,
// and nothing is posted in the room. Without AI, or when its summary fails validation, everything comes from verified
// match data; with AI, the headline and the points are written from that same data, numbers checked.
import { one, many, type Db, type Queryable } from '../db/index.ts';
import type { MatchEventRow, MatchRow, PollRow, RoomEventRow } from '../db/rows.ts';
import type { SessionUser } from '../auth/sessions.ts';
import { HttpError, onlyKeys, clamp, type RequestBody } from '../util.ts';
import { ai } from '../ai/index.ts';
import { SYSTEM, SCHEMAS, buildPrompt, validateOutput, allowedNumbersFrom } from '../ai/tasks.ts';
import { roomAccess } from '../rooms/service.ts';
import { takeToken } from '../limits.ts';
import { cached } from '../ai/context-cache.ts';
import { fixtureFor, type Fixture, type Signal, type Team } from '../match/fixture.ts';
import { rates, oversText, type BallRecord, type CricketState } from '../match/scorecard.ts';
import type { CricketItem } from '../match/demo-script.ts';
import { crowdLines } from '../match/crowd.ts';
import { matchContext } from './context.ts';

// A poll as Catch Me Up reads it: counts maps option index to votes, null before the first vote.
type PollCounts = Pick<PollRow, 'question' | 'options' | 'status'> & { counts: Record<string, number> | null };
interface Delta { label: string; value: string }
// A play that mattered: where in the game (over or clock), its tag ("Wicket", "Six", "Goal", "All out"), what
// happened and the score after it. weight (3 game-changing, 2 big, 1 notable) decides which stay when many happened.
interface Play { at: string; label: string; text: string; score: string; weight: number; event_id: string }
type Notable = Pick<Play, 'label' | 'text' | 'weight'>;
interface ThreadTalk { id: string; slug: string; about: string | null; members: number; crowd: number }
interface ThreadPoint { thread: string; id: string; text: string }

const MAX_PLAYS = 12;
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const overs = (balls: number) => (balls % 6 ? `${oversText(balls)} overs` : plural(balls / 6, 'over'));
const codes = (fixture: Fixture) => fixture.teams.map((t) => t.code);

// The score line: cricket's batting side with its overs, or both sides' scores.
function scoreLine(fixture: Fixture, s: any, short = false): string {
  if (fixture.sport === 'cricket') return short ? `${s.runs}/${s.wkts}` : `${s.batting} ${s.runs}/${s.wkts} (${oversText(s.balls)})`;
  const [a, b] = codes(fixture);
  return short ? `${s.score[a]}-${s.score[b]}` : `${a} ${s.score[a]}-${s.score[b]} ${b}`;
}

// The side ahead in a two-team score, or null when level (cricket has no lead to change).
function leaderOf(fixture: Fixture, s: any): string | null {
  if (fixture.sport === 'cricket') return null;
  const [a, b] = codes(fixture);
  return s.score[a] > s.score[b] ? a : s.score[b] > s.score[a] ? b : null;
}

// Cricket: wickets, sixes and fours, reviews, drops, the match's turning points (bowling change, last over, a new
// batter) and the pressure the momentum rules flag. Not every ball.
function cricketPlay(item: CricketItem, ball: BallRecord | null, signals: Signal[]): Notable | null {
  if (ball?.wicket) {
    const w = ball.wicket;
    const stand = signals.some((s) => s.trigger === 'partnership_break') ? `, ending a ${w.partnership.runs}-run stand` : '';
    return { label: 'Wicket', text: `${w.name} ${w.how}, ${w.r} (${w.b})${stand}.`, weight: 3 };
  }
  if (item.kind === 'event') {
    if (item.type === 'result') return { label: 'Result', text: item.text, weight: 3 };
    if (item.type === 'review') return { label: 'DRS', text: item.text, weight: 2 };
    return item.type === 'start' ? null : { label: item.label, text: item.text, weight: 1 };
  }
  if (!ball) return null;
  if (ball.drop) return { label: 'Dropped', text: ball.text, weight: 2 };
  if (ball.boundary) return ball.runs === 6 ? { label: 'Six', text: ball.text, weight: 2 } : { label: 'Four', text: ball.text, weight: 1 };
  const pressure = signals.find((s) => s.trigger === 'dot_ball_pressure' || s.trigger === 'required_run_rate_spike');
  return pressure ? { label: 'Pressure', text: pressure.fact_text, weight: 1 } : null;
}

// The other sports' moment rules, as a tag and weight: kabaddi, football and basketball.
const TAGS: Record<string, [string, number]> = {
  super_raid: ['Super raid', 3], all_out: ['All out', 3], super_tackle: ['Super tackle', 2], do_or_die: ['Do-or-die', 2], late_lead: ['Late lead', 2],
  goal: ['Goal', 3], late_equaliser: ['Goal', 3], late_go_ahead: ['Goal', 3], red_card: ['Red card', 3], penalty: ['Penalty', 2],
  go_ahead: ['Go-ahead', 3], buzzer_beater: ['Buzzer-beater', 3], lead_change: ['Lead change', 2], clutch_time: ['Clutch time', 1], hot_hand: ['Hot hand', 1],
  match_result_confirmed: ['Result', 3],
};

// Kabaddi, football and basketball: the moments their rules flag, yellow cards, lead changes and threes. A play that is
// several of these takes the weightiest tag (the rules' tag among equals).
function scriptedPlay(item: any, signals: Signal[], leadChanged: boolean): Notable | null {
  const tags: [string, number][] = [
    ...signals.map((s) => TAGS[s.trigger]).filter(Boolean),
    ...(item.card?.card === 'yellow' ? [['Yellow card', 1] as [string, number]] : []),
    ...(leadChanged ? [['Lead change', 2] as [string, number]] : []),
    ...(item.score?.points === 3 ? [['Three', 1] as [string, number]] : []),
  ];
  const best = tags.reduce<[string, number] | null>((top, t) => (!top || t[1] > top[1] ? t : top), null);
  return best && { label: best[0], text: item.text, weight: best[1] };
}

// What moved between then and now, by sport: cricket's runs, wickets, boundaries and required rate; kabaddi's points
// and all-outs; football's goals, cards and shots; basketball's points and lead changes.
function deltaFor(fixture: Fixture, from: any, now: any, leadChanges: number): Delta[] {
  if (fixture.sport === 'cricket') {
    const f: CricketState = from, n: CricketState = now;
    const out: Delta[] = [{ label: 'Runs', value: `+${n.runs - f.runs} off ${plural(n.balls - f.balls, 'ball')}` }];
    out.push({ label: 'Wickets', value: n.wkts > f.wkts ? `+${n.wkts - f.wkts}` : 'None' });
    const fours = n.fours - f.fours, sixes = n.sixes - f.sixes;
    if (fours || sixes) out.push({ label: 'Boundaries', value: [fours && plural(fours, 'four'), sixes && plural(sixes, 'six', 'sixes')].filter(Boolean).join(' · ') });
    const [then, rrr] = [rates(f).rrr, rates(n).rrr];
    if (!n.result && then != null && rrr != null) out.push({ label: 'Required rate', value: then === rrr ? `${rrr}` : `${then} → ${rrr}` });
    return out;
  }
  const [a, b] = codes(fixture);
  const gained = (code: string) => now.score[code] - from.score[code];
  if (fixture.sport === 'football') {
    const stat = (code: string, key: string) => now.stats[code][key] - from.stats[code][key];
    const cards = [a, b].map((c) => {
      const [y, r] = [stat(c, 'yellow'), stat(c, 'red')];
      return y || r ? `${c} ${[y && `${y} yellow`, r && `${r} red`].filter(Boolean).join(', ')}` : '';
    }).filter(Boolean);
    return [
      { label: 'Goals', value: gained(a) || gained(b) ? `${a} ${gained(a)} · ${b} ${gained(b)}` : 'None' },
      ...(cards.length ? [{ label: 'Cards', value: cards.join(' · ') }] : []),
      { label: 'Shots', value: `${a} ${stat(a, 'shots')} (${stat(a, 'on_target')} on target) · ${b} ${stat(b, 'shots')} (${stat(b, 'on_target')})` },
    ];
  }
  const out: Delta[] = [{ label: 'Points', value: `${a} +${gained(a)} · ${b} +${gained(b)}` }];
  if (fixture.sport === 'kabaddi') {
    // Two all-out points to one side mean the other side was all out.
    const allOut = [a, b].map((c) => [c, (now.points[c === a ? b : a].all_out - from.points[c === a ? b : a].all_out) / 2] as const)
      .filter(([, k]) => k > 0).map(([c, k]) => `${c} all out${k > 1 ? ` ${k} times` : ''}`);
    if (allOut.length) out.push({ label: 'All-outs', value: allOut.join(' · ') });
  } else if (leadChanges) out.push({ label: 'Lead changes', value: String(leadChanges) });
  return out;
}

// Who made it happen between then and now: cricket's top scorer and best bowler over that stretch, kabaddi's top
// raider and defender, basketball's top scorers. Football's goals and cards are already in the timeline.
function standouts(fixture: Fixture, from: any, now: any): string[] {
  if (fixture.sport === 'cricket') {
    const f: CricketState = from, n: CricketState = now;
    const card = (s: CricketState, name: string) => s.batters[name] || s.outs.find((o) => o.name === name);
    const batted = [...Object.keys(n.batters), ...n.outs.map((o) => o.name)].map((name) => {
      const was = card(f, name) || { r: 0, b: 0, fours: 0, sixes: 0 };
      const is = card(n, name)!;
      return { name, r: is.r - was.r, b: is.b - was.b, fours: is.fours - was.fours, sixes: is.sixes - was.sixes };
    }).filter((x) => x.b > 0).sort((x, y) => y.r - x.r || x.b - y.b);
    const bowled = Object.entries(n.bowlers).map(([name, v]) => {
      const was = f.bowlers[name] || { b: 0, r: 0, w: 0 };
      return { name, b: v.b - was.b, r: v.r - was.r, w: v.w - was.w };
    }).filter((x) => x.b > 0).sort((x, y) => y.w - x.w || x.r / x.b - y.r / y.b);
    const out: string[] = [];
    const top = batted[0];
    if (top?.r) {
      const hits = [top.fours && plural(top.fours, 'four'), top.sixes && plural(top.sixes, 'six', 'sixes')].filter(Boolean).join(', ');
      out.push(`${top.name} made ${top.r} off ${plural(top.b, 'ball')}${hits ? ` (${hits})` : ''}.`);
    }
    const best = bowled[0];
    if (best && (best.w || best.b >= 6)) out.push(`${best.name} took ${best.w} for ${best.r} in ${overs(best.b)}.`);
    return out;
  }
  if (fixture.sport === 'football') return [];
  const gains = (key: string) => Object.entries<any>(now.players).map(([name, p]) => ({ name, n: p[key] - (from.players[name]?.[key] || 0) }))
    .filter((x) => x.n > 0).sort((x, y) => y.n - x.n);
  if (fixture.sport === 'kabaddi') {
    const raider = gains('raid_points')[0], defender = gains('tackle_points')[0];
    return [raider && `${raider.name} scored ${plural(raider.n, 'raid point')}.`, defender && `${defender.name} made ${plural(defender.n, 'tackle point')}.`].filter(Boolean) as string[];
  }
  return gains('pts').slice(0, 2).map((p) => `${p.name} scored ${plural(p.n, 'point')}.`);
}

// Replays the run's verified events with the sport's engine: the game when the person left (the play current at
// `since`; the start of the run when null), the game now, and the plays that mattered in between, oldest first.
async function story(db: Queryable, matchId: string, since: Date | null) {
  const match = await one<Pick<MatchRow, 'fixture_key'>>(db, 'SELECT fixture_key FROM matches WHERE id = $1', [matchId]);
  const fixture = fixtureFor(match);
  const { engine } = fixture;
  const events = await many<Pick<MatchEventRow, 'id' | 'seq' | 'occurred_at'>>(db,
    'SELECT id, seq, occurred_at FROM match_events WHERE match_id = $1 ORDER BY seq', [matchId]);
  let state = engine.initialState(fixture);
  let from = state;
  let leader = leaderOf(fixture, state); // the last side to lead, kept through level scores
  let played = 0;
  let leadChanges = 0;
  const plays: Play[] = [];
  for (const e of events) {
    const item = fixture.items[e.seq];
    if (!item) continue;
    const { state: next, ball } = engine.applyItem(state, item, e.seq);
    const ahead = leaderOf(fixture, next);
    const leadChanged = Boolean(ahead && leader && ahead !== leader);
    leader = ahead || leader;
    if (since && new Date(e.occurred_at).getTime() <= since.getTime()) {
      state = from = next;
      continue;
    }
    played += 1;
    if (leadChanged) leadChanges += 1;
    const signals = engine.detectSignals(state, next, item, ball, e.seq);
    const p = fixture.sport === 'cricket' ? cricketPlay(item, ball as BallRecord | null, signals) : scriptedPlay(item, signals, leadChanged);
    if (p) plays.push({ ...p, at: engine.describe(item, state, next, ball).over, score: scoreLine(fixture, next), event_id: e.id });
    state = next;
  }
  // The weightiest plays when more than MAX_PLAYS happened (the latest first among equals), kept in game order.
  const keep = new Set(plays.map((p, i) => ({ p, i })).sort((x, y) => y.p.weight - x.p.weight || y.i - x.i).slice(0, MAX_PLAYS).map((x) => x.i));
  return { fixture, from, now: state, played, leadChanges, plays: plays.filter((_, i) => keep.has(i)) };
}

// "6 min" away; null when the person is asking about the match so far.
function awayFor(since: Date | null): string | null {
  if (!since) return null;
  const min = Math.round((Date.now() - since.getTime()) / 60000);
  if (min < 1) return 'under a minute';
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`;
}

// The change in one line: the result if it came in, else the score then → now ("CSK 128/2 → 157/3 while you were away").
function headlineFor(fixture: Fixture, from: any, now: any, wholeMatch: boolean): string {
  const when = wholeMatch ? '' : ' while you were away';
  if (now.result && !from.result) return `${String(now.result).replace(/\.$/, '')}${when}`;
  const side = fixture.sport === 'cricket' ? `${now.batting} ` : '';
  const [a, b] = codes(fixture);
  const move = fixture.sport === 'cricket' ? `${scoreLine(fixture, from, true)} → ${scoreLine(fixture, now, true)}`
    : `${a} ${scoreLine(fixture, from, true)} ${b} → ${scoreLine(fixture, now, true)}`;
  return wholeMatch ? `So far: ${side}${move}` : `${side}${move}${when}`;
}

export async function catchUp(db: Db, user: SessionUser, roomId: string, body: RequestBody) {
  onlyKeys(body, ['since_seq', 'scope']);
  const { room } = await roomAccess(db, roomId, user);
  const limited = await takeToken(db, `catchup:${user.id}`, { limit: 4, windowSeconds: 120 });
  if (!limited.ok) throw new HttpError(429, 'rate_limited', 'Give it a moment before catching up again.', { retry_after: limited.retryAfter });
  // scope 'match': the run so far and the room's recent talk. Otherwise since the person looked away (since_seq).
  const wholeMatch = body.scope === 'match';
  const floor = Math.max(0, room.last_seq - 300);
  const sinceSeq = wholeMatch ? floor : Number.isInteger(body.since_seq) ? clamp(body.since_seq, floor, room.last_seq) : Math.max(0, room.last_seq - 40);
  const sinceRow = wholeMatch ? null : await one<Pick<RoomEventRow, 'created_at'>>(db, 'SELECT created_at FROM room_events WHERE room_id = $1 AND seq <= $2 ORDER BY seq DESC LIMIT 1', [roomId, sinceSeq]);
  const since = sinceRow ? new Date(sinceRow.created_at) : null;

  const run = room.match_id ? await story(db, room.match_id, since) : null;
  const polls = await many<PollCounts>(db,
    `SELECT p.question, p.options, p.status,
            (SELECT jsonb_object_agg(option_index, n) FROM (SELECT option_index, count(*)::int AS n FROM poll_votes v WHERE v.poll_id = p.id GROUP BY option_index) c) AS counts
       FROM polls p WHERE p.room_id = $1 AND p.seq > $2 ORDER BY p.seq DESC LIMIT 3`, [roomId, sinceSeq]);
  const pollResults = polls.map((p) => {
    const counts: Record<string, number> = p.counts || {};
    const votes = Object.values(counts).reduce((x, y) => x + y, 0);
    const [leader, n] = p.options.map((o, i): [string, number] => [o.label, counts[i] || 0]).sort((x, y) => y[1] - x[1])[0];
    return { question: p.question, leader: votes ? leader : null, share: votes ? Math.round((n / votes) * 100) : null, votes };
  });

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

  // Deterministic, from verified data: always available, used when AI is off, unavailable or rejected.
  const mc = await matchContext(db, room);
  const people = new Set(messages.map((m) => m.from)).size;
  const change = run ? {
    from: scoreLine(run.fixture, run.from), to: scoreLine(run.fixture, run.now),
    teams: run.fixture.sport === 'cricket' ? run.fixture.teams.filter((t: Team) => t.code === run.now.batting) : run.fixture.teams,
  } : null;
  const delta = run?.played ? deltaFor(run.fixture, run.from, run.now, run.leadChanges) : [];
  const timeline = (run?.plays || []).map(({ at, label, text, score }) => ({ at, label, text, score }));
  const fallback = {
    headline: run?.played ? headlineFor(run.fixture, run.from, run.now, wholeMatch) : mc.facts?.headline || 'No match data for this room',
    match_points: run?.played ? standouts(run.fixture, run.from, run.now) : [],
    thread_points: threads.slice(0, 3).map((t): ThreadPoint => ({
      thread: t.slug, id: t.id,
      text: [t.members ? `${plural(t.members, 'message')} from members` : '', t.crowd ? `${t.crowd} from the stands` : ''].filter(Boolean).join(', ') + '.',
    })),
    room_points: [
      messages.length ? `${plural(messages.length, 'message')} from ${plural(people, 'member')}.`
        : wholeMatch ? 'No messages from members yet.' : 'No messages from members while you were away.',
      crowd.length ? `${plural(crowd.length, 'line')} from fans in the stands.` : '',
    ].filter(Boolean),
  };
  const base = {
    scope: wholeMatch ? 'match' : 'since', away: awayFor(since), change, delta, timeline, polls: pollResults,
    data_as_of: mc.freshness?.latest_verified_update || null, stale: Boolean(mc.freshness?.stale), source_label: 'Match facts from the match feed',
  };
  if (!messages.length && !run?.played && !crowd.length && !polls.length) return { ...fallback, ...base, source: 'match_data', note: 'Nothing new since you looked away.' };

  const orchestrator = await ai();
  if (!room.ai_enabled || !orchestrator.available) return { ...fallback, ...base, source: 'match_data' };
  const plays = run?.plays || [];
  const allowedEventIds = new Set<string>([...mc.allowedEventIds, ...plays.map((p) => p.event_id)]);
  const allowedNumbers = new Set<string>([...mc.allowedNumbers, ...allowedNumbersFrom(change && { from: change.from, to: change.to }, delta, timeline, fallback.match_points)]);
  const result = await cached(roomId, `catchup:${user.id}:${base.scope}:${sinceSeq}:${room.last_seq}`, 20000, () => orchestrator.run({
    task: 'catchup', system: SYSTEM, schema: SCHEMAS.catchup, roomId, userId: user.id, deadline: 14000, timeoutMs: 6000,
    user: buildPrompt('catchup', {
      SCOPE: wholeMatch ? 'the match so far' : 'since the member looked away',
      AWAY: base.away ?? undefined,
      CHANGE: change ? { then: change.from, now: change.to } : undefined,
      WHAT_CHANGED: delta,
      PLAYS_THAT_MATTERED: plays.map(({ at, label, text, score, event_id }) => ({ event_id, at, label, text, score_after: score })),
      STANDOUTS: fallback.match_points,
      VERIFIED_MATCH_DATA: mc.facts,
      POLLS: pollResults,
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
