// Context builders for the AI Co-host. Each builds the minimum, purpose-specific context on the server:
// verified match facts (with source and freshness) kept apart from untrusted room text, and room text taken
// only from the one room the request is authorised for. Members appear as pseudonyms, never names or phones.
import { config } from '../config.js';
import { one, many } from '../db/index.js';
import { matchSnapshot } from '../match/feed.js';
import { allowedNumbersFrom } from '../ai/tasks.js';

export async function matchContext(db, room) {
  if (!room.match_id) return { facts: null, commentary: [], freshness: null, allowedEventIds: new Set(), allowedNumbers: new Set() };
  const snap = await matchSnapshot(db, room.match_id);
  if (!snap) return { facts: null, commentary: [], freshness: null, allowedEventIds: new Set(), allowedNumbers: new Set() };
  const s = snap.score;
  const facts = {
    match: snap.match.title, format: snap.match.format, status: snap.match.status,
    source: snap.match.source, source_note: snap.match.source_label,
    batting: s.batting, bowling: s.bowling, score: `${s.runs}/${s.wickets}`, overs: s.overs, target: s.target,
    need_runs: s.need_runs, balls_left: s.need_balls, current_run_rate: s.crr, required_run_rate: s.rrr,
    first_innings: s.first_innings, result: s.result,
    batters: s.batters.map((b) => `${b.name} ${b.runs} (${b.balls})${b.on_strike ? ' on strike' : ''}`),
    bowler: s.bowler ? `${s.bowler.name} ${s.bowler.figures}` : null,
    bowling_card: s.bowling_card.map((b) => `${b.name} ${b.figures}`),
    fall_of_wickets: s.fall_of_wickets.map((w) => `${w.name} ${w.r} (${w.b}) ${w.how}${w.score ? ` at ${w.score}` : ''}${w.over ? ` in ${w.over} ov` : ''}`),
    this_over: s.this_over.join(' '),
  };
  const commentary = snap.commentary.map((c) => ({ event_id: c.event_id, over: c.over, label: c.label, text: c.text, occurred_at: c.occurred_at }));
  const freshness = { latest_verified_update: snap.freshness.updated_at, age_seconds: snap.freshness.age_seconds, stale: snap.freshness.stale };
  return {
    facts, commentary, freshness,
    allowedEventIds: new Set(commentary.map((c) => c.event_id)),
    allowedNumbers: allowedNumbersFrom(facts, commentary),
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
