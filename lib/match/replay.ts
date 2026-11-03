// A private room's own copy of the simulated replay. It is created with the room when the owner asks for it,
// and only that room's owner and admins can start, pause, speed up, restart or jump it (lib/rooms/replay.js
// checks who may). Moving it never moves the shared replay that the public watch party follows. Demo data,
// labelled as a simulated replay wherever it appears.
import { config } from '../config.ts';
import { one, type Db, type Queryable } from '../db/index.ts';
import type { MatchRow, RoomRow } from '../db/rows.ts';
import { HttpError, conflict, newId } from '../util.ts';
import { FIXTURES, DEMO_FIXTURE, fixtureFor, schedule } from './fixture.ts';
import { matchState, ingestDue, jumpToMoment, intervalFor } from './feed.ts';

export const SPEEDS = [0.5, 1, 2];

interface ReplayOptions { start?: boolean; intervalMs?: number }

export async function createRoomReplay(q: Queryable, roomId: string, fixtureKey: string, { start = false, intervalMs = intervalFor(config().match.defaultSpeed) }: ReplayOptions = {}): Promise<string> {
  const f = FIXTURES[fixtureKey] || DEMO_FIXTURE;
  const id = newId('mat');
  await q.query(
    `INSERT INTO matches (id, fixture_key, title, team_a, team_b, format, source, status, feed_started_at, ball_interval_ms, room_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'demo_fixture', CASE WHEN $7::boolean THEN 'live' ELSE 'scheduled' END,
             CASE WHEN $7::boolean THEN now() END, $8, $9)`,
    [id, f.key, f.title, f.teams[0].code, f.teams[1].code, f.format, start, intervalMs, roomId]);
  return id;
}

const stateError = (message: string) => conflict(message, 'replay_state');

export async function startReplay(db: Db, m: MatchRow) {
  const ok = await one<Pick<MatchRow, 'id'>>(db,
    `UPDATE matches SET status = 'live', feed_started_at = now(), paused_at = NULL WHERE id = $1 AND status = 'scheduled' RETURNING id`, [m.id]);
  if (!ok) throw stateError(m.status === 'completed' ? 'The replay has finished. Restart it to watch again.' : 'The replay is already running.');
  await ingestDue(db, m.id);
}

export async function pauseReplay(db: Queryable, m: MatchRow) {
  const ok = await one<Pick<MatchRow, 'id'>>(db,
    `UPDATE matches SET paused_at = now() WHERE id = $1 AND status = 'live' AND paused_at IS NULL RETURNING id`, [m.id]);
  if (!ok) throw stateError('The replay is not playing.');
}

// The clock moves on by however long the replay was paused, so nothing is skipped.
export async function resumeReplay(db: Db, m: MatchRow) {
  const ok = await one<Pick<MatchRow, 'id'>>(db,
    `UPDATE matches SET feed_started_at = feed_started_at + (now() - paused_at), paused_at = NULL
      WHERE id = $1 AND status = 'live' AND paused_at IS NOT NULL RETURNING id`, [m.id]);
  if (!ok) throw stateError('The replay is not paused.');
  await ingestDue(db, m.id);
}

// Keeps the replay where it is: the next ball arrives one gap (at the new pace) after the last one.
export async function setReplaySpeed(db: Db, matchId: string, speed: number) {
  await db.tx(async (q) => {
    // The caller has just read this match, and matches are never deleted.
    const m = (await one<MatchRow>(q, 'SELECT * FROM matches WHERE id = $1 FOR UPDATE', [matchId]))!;
    const intervalMs = intervalFor(speed);
    if (m.status !== 'live') {
      await q.query('UPDATE matches SET ball_interval_ms = $2 WHERE id = $1', [m.id, intervalMs]);
      return;
    }
    const offsets = schedule(fixtureFor(m), intervalMs / 1000);
    const state = await matchState(q, m);
    const at = state.last_seq >= 0 ? offsets[state.last_seq] : 0;
    await q.query(
      `UPDATE matches SET ball_interval_ms = $2, feed_started_at = COALESCE(paused_at, now()) - $3::float8 * interval '1 second' WHERE id = $1`,
      [m.id, intervalMs, at]);
  });
}

// A fresh run from the first ball, at the same pace. The room moves to it in the same transaction and the
// old run is closed, so its alert history still counts towards the per-match cap (lib/notify).
export async function restartReplay(db: Db, roomId: string, m: MatchRow): Promise<string> {
  return db.tx(async (q) => {
    const room = await one<Pick<RoomRow, 'match_id'>>(q, 'SELECT match_id FROM rooms WHERE id = $1 FOR UPDATE', [roomId]);
    if (!room || room.match_id !== m.id) throw stateError('The replay just changed. Try again.');
    const id = await createRoomReplay(q, roomId, m.fixture_key, { start: true, intervalMs: m.ball_interval_ms });
    await q.query('UPDATE rooms SET match_id = $2 WHERE id = $1', [roomId, id]);
    await q.query(`UPDATE matches SET status = 'completed', completed_at = COALESCE(completed_at, now()), paused_at = NULL WHERE id = $1`, [m.id]);
    return id;
  });
}

// Jumping to a moment the replay has already passed starts a fresh run and jumps that one instead.
export async function momentNeedsRestart(db: Queryable, m: MatchRow, momentId: string): Promise<boolean> {
  const moment = fixtureFor(m).moments.find((x) => x.id === momentId);
  if (!moment) throw new HttpError(400, 'invalid_moment', 'Unknown moment.');
  return m.status === 'completed' || moment.index <= (await matchState(db, m)).last_seq;
}

export async function jumpReplay(db: Db, roomId: string, m: MatchRow, momentId: string) {
  const matchId = (await momentNeedsRestart(db, m, momentId)) ? await restartReplay(db, roomId, m) : m.id;
  return jumpToMoment(db, matchId, momentId);
}
