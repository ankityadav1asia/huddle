// Context builders for the AI Co-host. Each builds the minimum, purpose-specific context on the server:
// verified match facts (with source and freshness) kept apart from untrusted room text, and room text taken
// only from the one room the request is authorised for. Members appear as pseudonyms, never names or phones.
import { one, many, type Queryable } from '../db/index.ts';
import type { MatchEventRow, MatchRow, MessageRow, RoomRow, SignalRow } from '../db/rows.ts';
import { matchSnapshot, stateAt } from '../match/feed.ts';
import { fixtureFor } from '../match/fixture.ts';
import { allowedNumbersFrom } from '../ai/tasks.ts';

// A member's chat message. User messages always have a sender and text; MessageRow allows null for AI rows.
type MemberMessage = Pick<MessageRow, 'id' | 'seq' | 'created_at'> & { sender_id: string; body: string };
// Match events and published moments since a point in time, as Catch Me Up reads them.
type EventSince = Pick<MatchEventRow, 'kind' | 'data' | 'occurred_at'> & { event_id: string };
type SignalSince = Pick<SignalRow, 'label' | 'priority' | 'fact_text' | 'event_id'>;

// story: also the sport's record of the whole game up to the latest play (for answering questions about any moment);
// its numbers may then be stated too.
export async function matchContext(db: Queryable, room: Pick<RoomRow, 'match_id'>, { story = false } = {}) {
  const snap = room.match_id ? await matchSnapshot(db, room.match_id) : null;
  if (!snap) return { facts: null, story: null, commentary: [], freshness: null, allowedEventIds: new Set<string>(), allowedNumbers: new Set<string>() };
  const fixture = fixtureFor(snap.match);
  const facts = fixture.engine.facts(snap); // each sport decides which verified fields the AI may state
  const record = story ? fixture.story?.(snap.rev) ?? null : null;
  const commentary = snap.commentary.map((c) => ({ event_id: c.event_id, over: c.over, label: c.label, text: c.text, occurred_at: c.occurred_at }));
  const freshness = { latest_verified_update: snap.freshness.updated_at, age_seconds: snap.freshness.age_seconds, stale: snap.freshness.stale };
  return {
    facts, story: record, commentary, freshness,
    allowedEventIds: new Set<string>(commentary.map((c) => c.event_id)),
    allowedNumbers: allowedNumbersFrom(facts, commentary, record),
  };
}

// The game when a question was asked (the newest feed item at that instant) and the plays just before it, plus the
// sport's checked rules sheet and roster. An answer's numbers must come from these or the current match data.
export async function askedContext(db: Queryable, room: Pick<RoomRow, 'match_id'>, matchSeq: number | null) {
  if (!room.match_id) return null;
  const match = await one<MatchRow>(db, 'SELECT * FROM matches WHERE id = $1', [room.match_id]);
  if (!match) return null;
  const fixture = fixtureFor(match);
  const guide = { sport: fixture.sportName, rules: fixture.rules, roster: fixture.roster };
  if (matchSeq == null) return { ...guide, whenAsked: null, eventIds: [] };
  const state = stateAt(fixture, matchSeq);
  const recent = await many<Pick<MatchEventRow, 'id' | 'seq' | 'data'>>(db,
    `SELECT id, seq, data FROM match_events WHERE match_id = $1 AND seq <= $2 AND kind <> 'overend' ORDER BY seq DESC LIMIT 5`,
    [match.id, matchSeq]);
  const snap = { match: { title: match.title, format: match.format, status: match.status, source: match.source, source_label: fixture.sourceLabel }, score: fixture.engine.snapshot(state) };
  // When it was asked: the game clock where the sport has one; in cricket, the latest delivery.
  const lastBall: { label: string } | undefined = state.ball_log?.at(-1);
  return {
    ...guide,
    whenAsked: {
      at: fixture.items[matchSeq]?.clock || (lastBall ? `Over ${lastBall.label}` : null),
      match: fixture.engine.facts(snap),
      just_before: recent.reverse().map((e) => ({ event_id: e.id, text: e.data.text || e.data.label || '' })),
    },
    eventIds: recent.map((e) => e.id),
  };
}

// Recent human messages from this room only, pseudonymised; never AI output.
export async function roomMessages(db: Queryable, roomId: string, { limit = 15, sinceSeq = null }: { limit?: number; sinceSeq?: number | null } = {}) {
  const rows = await many<MemberMessage>(db,
    `SELECT id, seq, sender_id, body, created_at FROM messages
      WHERE room_id = $1 AND sender_type = 'user' AND status = 'visible' AND ($2::int IS NULL OR seq > $2::int)
      ORDER BY seq DESC LIMIT $3`,
    [roomId, sinceSeq, limit]);
  const alias = new Map<string, string>();
  return rows.reverse().map((r) => {
    if (!alias.has(r.sender_id)) alias.set(r.sender_id, `member${alias.size + 1}`);
    return { message_id: r.id, from: alias.get(r.sender_id), text: r.body.slice(0, 300), at: r.created_at };
  });
}

export async function eventsSince(db: Queryable, matchId: string | null, since: Date | null): Promise<EventSince[]> {
  if (!matchId) return [];
  return many<EventSince>(db,
    `SELECT e.id AS event_id, e.kind, e.data, e.occurred_at FROM match_events e
      WHERE e.match_id = $1 AND e.kind <> 'overend' AND ($2::timestamptz IS NULL OR e.occurred_at > $2::timestamptz)
      ORDER BY e.seq DESC LIMIT 36`,
    [matchId, since]);
}

export async function publishedSignalsSince(db: Queryable, matchId: string | null, since: Date | null): Promise<SignalSince[]> {
  if (!matchId) return [];
  return many<SignalSince>(db,
    `SELECT s.label, s.priority, s.fact_text, s.event_id FROM match_signals s JOIN match_events e ON e.id = s.event_id
      WHERE s.match_id = $1 AND s.status IN ('published', 'suppressed') AND s.priority IN ('high', 'medium')
        AND ($2::timestamptz IS NULL OR e.occurred_at > $2::timestamptz)
      ORDER BY e.seq LIMIT 8`,
    [matchId, since]);
}
