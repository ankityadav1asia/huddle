// Match data ingestion, shared by every room following the match (one feed per match, never per room).
// Ingestion validates order, timestamps and dedupes by provider event id, stores events, runs the momentum
// rules, and queues one explanation job per surviving signal.
import { config } from '../config.ts';
import { one, many } from '../db/index.ts';
import { HttpError, newId, notFound } from '../util.ts';
import { fixtureFor, schedule, providerEventId, DEMO_FIXTURE, FIXTURE_ORDER, FIXTURES } from './fixture.ts';
import { rank } from './momentum.ts';
import { enqueue } from '../jobs/queue.ts';
import { notifyRoom } from '../realtime/bus.ts';
import { openMomentThreads } from '../rooms/threads.ts';
import { log } from '../log.ts';

const cache = new Map(); // match id -> { seq, state }

export async function matchState(q, match) {
  const fixture = fixtureFor(match);
  const { engine } = fixture;
  const hit = cache.get(match.id);
  const last = (await one(q, 'SELECT COALESCE(max(seq), -1)::int AS seq FROM match_events WHERE match_id = $1', [match.id])).seq;
  if (hit && hit.seq === last) return hit.state;
  let state = hit && hit.seq < last ? hit.state : engine.initialState(fixture);
  const from = hit && hit.seq < last ? hit.seq : -1;
  const rows = await many(q, 'SELECT seq FROM match_events WHERE match_id = $1 AND seq > $2 ORDER BY seq', [match.id, from]);
  for (const r of rows) state = engine.applyItem(state, fixture.items[r.seq], r.seq).state;
  cache.set(match.id, { seq: last, state });
  return state;
}

// The match as it stood after feed item `seq`: what was happening when someone asked a question.
export function stateAt(fixture, seq) {
  let state = fixture.engine.initialState(fixture);
  for (let i = 0; i <= seq && i < fixture.items.length; i++) state = fixture.engine.applyItem(state, fixture.items[i], i).state;
  return state;
}

export function clearMatchCache() {
  cache.clear();
}

// A shared run starts at the current demo pace, even one created under an older DEMO_SPEED; a private room's own
// replay keeps the pace its host chose.
export async function startMatchIfScheduled(db, matchId) {
  await db.query(
    `UPDATE matches SET status = 'live', feed_started_at = now(),
       ball_interval_ms = CASE WHEN room_id IS NULL THEN $2 ELSE ball_interval_ms END
     WHERE id = $1 AND status = 'scheduled'`,
    [matchId, intervalFor(config().match.defaultSpeed)],
  );
}

// Keeps one shared demo match per sport available, each with its platform-managed public room. Private rooms' own
// replay runs (room_id set) never count as a shared match. Returns the match id for `fixtureKey` (cricket by default).
export async function ensureDemoMatches(db) {
  const live = await many(db, `SELECT fixture_key FROM matches WHERE status IN ('scheduled', 'live') AND room_id IS NULL`);
  const have = new Set(live.map((m) => m.fixture_key));
  for (const f of FIXTURE_ORDER) if (!have.has(f.key)) await ensureDemoMatch(db, f.key);
}

export async function ensureDemoMatch(db, fixtureKey = DEMO_FIXTURE.key) {
  return db.tx(async (q) => {
    await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ensure-demo-match:${fixtureKey}`]);
    const current = await one(q,
      `SELECT id FROM matches WHERE status IN ('scheduled', 'live') AND room_id IS NULL AND fixture_key = $1 ORDER BY created_at DESC LIMIT 1`, [fixtureKey]);
    if (current) return current.id;
    const f = FIXTURES[fixtureKey] || DEMO_FIXTURE;
    const id = newId('mat');
    await q.query(
      `INSERT INTO matches (id, fixture_key, title, team_a, team_b, format, source, status, ball_interval_ms)
       VALUES ($1, $2, $3, $4, $5, $6, 'demo_fixture', 'scheduled', $7)`,
      [id, f.key, f.title, f.teams[0].code, f.teams[1].code, f.format, intervalFor(config().match.defaultSpeed)],
    );
    await q.query(
      `INSERT INTO rooms (id, name, room_type, match_id) VALUES ($1, $2, 'public', $3)`,
      [newId('room'), `${f.title} · Public watch party`, id],
    );
    return id;
  });
}

// Ingests every fixture item that is due. Serialised per match with a row lock so concurrent pumps
// on several instances cannot interleave. Returns the number of new events.
export async function ingestDue(db, matchId) {
  const cfg = config();
  const result = await db.tx(async (q) => {
    const m = await one(q, `SELECT *, EXTRACT(EPOCH FROM (now() - feed_started_at))::float8 AS elapsed FROM matches WHERE id = $1 FOR UPDATE`, [matchId]);
    if (!m || m.status !== 'live' || m.paused_at || m.elapsed == null || m.elapsed < 0) return null;
    const fixture = fixtureFor(m);
    const offsets = schedule(fixture, m.ball_interval_ms / 1000);
    let state = await matchState(q, m);
    const due: number[] = [];
    for (let i = state.last_seq + 1; i < fixture.items.length && offsets[i] <= m.elapsed; i++) due.push(i);
    if (!due.length) return null;

    const found: any[] = [];
    const opened: { slug: string; about: string; keywords: string[] }[] = [];
    for (const i of due) {
      const item = fixture.items[i];
      const occurredAt = new Date(new Date(m.feed_started_at).getTime() + offsets[i] * 1000);
      const ageSeconds = m.elapsed - offsets[i];
      const backfilled = i <= m.backfill_until;
      const ev = await one(q,
        `INSERT INTO match_events (id, match_id, provider_event_id, seq, kind, data, occurred_at, backfilled)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
         ON CONFLICT (match_id, provider_event_id) DO NOTHING RETURNING id`,
        [newId('mev'), m.id, providerEventId(fixture, i), i, item.kind, JSON.stringify(eventData(item)), occurredAt, backfilled]);
      const { state: next, ball } = fixture.engine.applyItem(state, item, i);
      if (ev) {
        for (const s of fixture.engine.detectSignals(state, next, item, ball, i)) {
          found.push({ ...s, eventId: ev.id, occurredAt, stale: backfilled || ageSeconds > cfg.match.freshnessSeconds, backfilled });
        }
        const thread = backfilled ? null : fixture.engine.threadForItem(item);
        if (thread) opened.push(thread);
      }
      state = next;
    }
    cache.set(m.id, { seq: state.last_seq, state });
    await openMomentThreads(q, m.id, opened); // a #thread for each big moment, in every room following the match

    // Only fresh signals alert, and a burst of several in one pass publishes just the most important one.
    const fresh = found.filter((s) => !s.stale);
    const keep = fresh.reduce((best, s) => (!best || rank(s.priority) >= rank(best.priority) ? s : best), null);
    const queued: string[] = [];
    for (const s of found) {
      const status = s === keep ? 'pending' : 'suppressed';
      const reason = s === keep ? null : s.backfilled ? 'backfill' : s.stale ? 'stale' : 'batched';
      const ttl = s.priority === 'high' ? 180 : 90;
      const row = await one(q,
        `INSERT INTO match_signals (id, match_id, event_id, trigger, priority, label, evidence, fact_text, dedupe_key, status, status_reason, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12::timestamptz + make_interval(secs => $13))
         ON CONFLICT (dedupe_key) DO NOTHING RETURNING id, status`,
        [newId('sig'), m.id, s.eventId, s.trigger, s.priority, s.label, JSON.stringify(s.evidence), s.fact_text,
          `${m.id}:${s.trigger}:${s.dedupe}`, status, reason, s.occurredAt, ttl]);
      if (row?.status === 'pending') {
        await enqueue(q, { type: 'momentum_signal', dedupeKey: `signal:${row.id}`, payload: { signal_id: row.id }, priority: 1, expiresInSeconds: ttl, maxAttempts: 2 });
        queued.push(row.id);
      }
    }
    let completed = false;
    if (state.last_seq === fixture.items.length - 1) {
      await q.query(`UPDATE matches SET status = 'completed', completed_at = now() WHERE id = $1`, [m.id]);
      completed = true;
      const rooms = await many(q, `SELECT id FROM rooms WHERE match_id = $1 AND status = 'active'`, [m.id]);
      for (const r of rooms) {
        await enqueue(q, { type: 'room_auto_end', dedupeKey: `autoend:${r.id}:${m.id}`, payload: { room_id: r.id, match_id: m.id }, delaySeconds: cfg.rooms.autoEndMinutesAfterMatch * 60, priority: 6 });
      }
    }
    const rooms = await many(q, `SELECT id FROM rooms WHERE match_id = $1 AND status = 'active'`, [m.id]);
    return { added: due.length, signals: queued.length, completed, rooms: rooms.map((r) => r.id) };
  });
  if (result) {
    result.rooms.forEach(notifyRoom);
    if (result.signals || result.completed) log.info('match.ingest', { match: matchId, added: result.added, signals: result.signals, completed: result.completed });
  }
  return result?.added || 0;
}

function eventData(item) {
  const { crowd, host, urgent, hold, pause, moment, signal, thread, ...data } = item;
  return data;
}

export async function advanceFeeds(db) {
  const live = await many(db, `SELECT id FROM matches WHERE status = 'live' AND paused_at IS NULL AND feed_started_at <= now()`);
  let added = 0;
  for (const m of live) added += await ingestDue(db, m.id);
  return added;
}

// Move the replay clock forward to a named moment (a paused replay plays on from there). Skipped items are
// ingested as backfill, which never alerts. Used by a private room's own replay controls, and by the
// DEMO_CONTROLS jump for the shared replay; both are labelled as replay controls in the UI.
export async function jumpToMoment(db, matchId, momentId) {
  const m = await one(db, 'SELECT * FROM matches WHERE id = $1', [matchId]);
  if (!m) throw notFound('Match not found.');
  const fixture = fixtureFor(m);
  const moment = fixture.moments.find((x) => x.id === momentId);
  if (!moment) throw new HttpError(400, 'invalid_moment', 'Unknown moment.');
  const state = await matchState(db, m);
  if (m.status === 'completed' || moment.index <= state.last_seq) throw new HttpError(409, 'moment_passed', 'The replay is already past that moment.');
  const offsets = schedule(fixture, m.ball_interval_ms / 1000);
  await db.query(
    `UPDATE matches SET status = 'live', paused_at = NULL, backfill_until = $2, feed_started_at = now() - $3::float8 * interval '1 second' WHERE id = $1`,
    [m.id, moment.index - 1, offsets[moment.index] - 1.5],
  );
  await ingestDue(db, m.id);
  return { jumped_to: moment.label };
}

export async function matchSnapshot(db, matchId) {
  const m = await one(db, `SELECT *, EXTRACT(EPOCH FROM (now() - feed_started_at))::float8 AS elapsed FROM matches WHERE id = $1`, [matchId]);
  if (!m) return null;
  const fixture = fixtureFor(m);
  const state = await matchState(db, m);
  const last = await one(db,
    `SELECT occurred_at, EXTRACT(EPOCH FROM (now() - occurred_at))::float8 AS age FROM match_events WHERE match_id = $1 ORDER BY seq DESC LIMIT 1`, [m.id]);
  const recent = await many(db,
    `SELECT id, seq, kind, data, occurred_at FROM match_events WHERE match_id = $1 AND kind <> 'overend' ORDER BY seq DESC LIMIT 10`, [m.id]);
  const labels = new Map<number, any>((state.ball_log || []).map((b) => [b.seq, b])); // cricket ball labels; other sports carry a clock
  const staleAfter = config().match.staleAfterSeconds;
  const own = Boolean(m.room_id);
  return {
    match: {
      id: m.id, title: m.title, teams: fixture.teams, format: m.format, status: m.status,
      source: m.source, source_label: fixture.sourceLabel, sport: fixture.sport, sport_name: fixture.sportName, fixture_key: fixture.key,
    },
    freshness: {
      updated_at: last?.occurred_at || null,
      age_seconds: last ? Math.round(last.age) : null,
      stale: m.status === 'live' && !m.paused_at && (!last || last.age > staleAfter),
    },
    score: fixture.engine.snapshot(state),
    commentary: recent.map((e) => ({
      event_id: e.id, kind: e.kind, over: labels.get(e.seq)?.label || e.data.clock || null, symbol: labels.get(e.seq)?.symbol || null,
      label: e.data.label || null, text: e.data.text || '', occurred_at: e.occurred_at,
    })),
    moments: !own && config().demoControls && m.status !== 'completed' ? fixture.moments.filter((x) => x.index > state.last_seq).map((x) => ({ id: x.id, label: x.label })) : [],
    // own: this room's private copy of the replay, which its owner and admins control.
    replay: {
      own,
      paused: Boolean(m.paused_at),
      speed: replaySpeed(m),
      moments: own ? fixture.moments.map((x) => ({ id: x.id, label: x.label, passed: m.status === 'completed' || x.index <= state.last_seq })) : [],
    },
    rev: state.last_seq,
  };
}

// 1 at the configured pace (DEMO_BALL_SECONDS per ball), 0.5 at half that, 2 at twice it.
export function replaySpeed(m) {
  return Math.max(0.5, Math.round(((config().match.ballSeconds * 1000) / m.ball_interval_ms) * 2) / 2);
}

export const intervalFor = (speed) => Math.round((config().match.ballSeconds * 1000) / speed);
