// Context builders for the AI Co-host. Each builds the minimum, purpose-specific context on the server:
// verified match facts (with source and freshness) kept apart from untrusted room text, and room text taken
// only from the one room the request is authorised for. Members appear as pseudonyms, never names or phones.
import { config } from '../config.js';
import { one, many } from '../db/index.js';
import { matchSnapshot, stateAt } from '../match/feed.js';
import { fixtureFor } from '../match/fixture.js';
import { allowedNumbersFrom } from '../ai/tasks.js';

export async function matchContext(db, room) {
  if (!room.match_id) return { facts: null, commentary: [], freshness: null, allowedEventIds: new Set(), allowedNumbers: new Set() };
  const snap = await matchSnapshot(db, room.match_id);
  if (!snap) return { facts: null, commentary: [], freshness: null, allowedEventIds: new Set(), allowedNumbers: new Set() };
  const fixture = fixtureFor(snap.match);
  const facts = fixture.engine.facts(snap); // each sport decides which verified fields the AI may state
  const commentary = snap.commentary.map((c) => ({ event_id: c.event_id, over: c.over, label: c.label, text: c.text, occurred_at: c.occurred_at }));
  const freshness = { latest_verified_update: snap.freshness.updated_at, age_seconds: snap.freshness.age_seconds, stale: snap.freshness.stale };
  return {
    facts, commentary, freshness,
    allowedEventIds: new Set(commentary.map((c) => c.event_id)),
    allowedNumbers: allowedNumbersFrom(facts, commentary),
  };
}

// The game as it stood when a question was asked (the newest feed item at that instant), with the plays just
// before it, plus the sport's checked rules sheet and roster. Numbers in an answer must come from these or from the
// current match data.
export async function askedContext(db, room, matchSeq) {
  if (!room.match_id) return null;
  const match = await one(db, 'SELECT * FROM matches WHERE id = $1', [room.match_id]);
  if (!match) return null;
  const fixture = fixtureFor(match);
  const guide = { sport: fixture.sportName, rules: fixture.rules, roster: fixture.roster };
  if (matchSeq == null) return { ...guide, whenAsked: null, eventIds: [] };
  const state = stateAt(fixture, matchSeq);
  const recent = await many(db,
    `SELECT id, seq, data FROM match_events WHERE match_id = $1 AND seq <= $2 AND kind <> 'overend' ORDER BY seq DESC LIMIT 5`,
    [match.id, matchSeq]);
  const snap = { match: { title: match.title, format: match.format, status: match.status, source: match.source, source_label: fixture.sourceLabel }, score: fixture.engine.snapshot(state) };
  return {
    ...guide,
    whenAsked: {
      at: fixture.items[matchSeq]?.clock || null,
      match: fixture.engine.facts(snap),
      just_before: recent.reverse().map((e) => ({ event_id: e.id, text: e.data.text || e.data.label || '' })),
    },
    eventIds: recent.map((e) => e.id),
  };
}

// Recent human messages from this room only, pseudonymised. Never another room, never AI output.
export async function roomMessages(db, roomId, { limit = 15, sinceSeq = null } = {}) {
  const rows = await many(db,
    `SELECT id, seq, sender_id, body, created_at FROM messages
      WHERE room_id = $1 AND sender_type = 'user' AND status = 'visible' AND ($2::int IS NULL OR seq > $2::int)
      ORDER BY seq DESC LIMIT $3`,
    [roomId, sinceSeq, limit]);
  const alias = new Map();
  return rows.reverse().map((r) => {
    if (!alias.has(r.sender_id)) alias.set(r.sender_id, `member${alias.size + 1}`);
    return { message_id: r.id, from: alias.get(r.sender_id), text: r.body.slice(0, 300), at: r.created_at };
  });
}

export async function eventsSince(db, matchId, since) {
  if (!matchId) return [];
  return many(db,
    `SELECT e.id AS event_id, e.kind, e.data, e.occurred_at FROM match_events e
      WHERE e.match_id = $1 AND e.kind <> 'overend' AND ($2::timestamptz IS NULL OR e.occurred_at > $2::timestamptz)
      ORDER BY e.seq DESC LIMIT 36`,
    [matchId, since]);
}

export async function publishedSignalsSince(db, matchId, since) {
  if (!matchId) return [];
  return many(db,
    `SELECT s.label, s.priority, s.fact_text, s.event_id FROM match_signals s JOIN match_events e ON e.id = s.event_id
      WHERE s.match_id = $1 AND s.status IN ('published', 'suppressed') AND s.priority IN ('high', 'medium')
        AND ($2::timestamptz IS NULL OR e.occurred_at > $2::timestamptz)
      ORDER BY e.seq LIMIT 8`,
    [matchId, since]);
}

export async function roomIsLive(db, roomId) {
  const r = await one(db, `SELECT status, ai_enabled FROM rooms WHERE id = $1`, [roomId]);
  return Boolean(r && r.status === 'active');
}

export const quietWindowSeconds = () => config().cohost.quietMinutes * 60;
