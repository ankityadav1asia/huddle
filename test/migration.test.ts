import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPglite } from '../lib/db/index.ts';
import { migrate } from '../lib/db/migrate.ts';
import { newId } from '../lib/util.ts';
import { matchSnapshot } from '../lib/match/feed.ts';

process.env.HUDDLE_SECRET ||= 'test-secret-not-real'; // so reading the config never writes a dev secret

// Migration 013 on a database as release 012 left it: rooms on their own runs, demo friends with invitations and
// more, push subscriptions and their delivery jobs.
test('migration 013 moves rooms onto the shared games, drops notifications and deletes the demo friends', async () => {
  const db = await openPglite(null);
  await migrate(db, { upTo: 12 });
  const id = (prefix: string) => newId(prefix);
  const [owner, friend, demo] = [id('usr'), id('usr'), id('usr')];
  const m = { cricket: id('mat'), cricketDone: id('mat'), cricketOwn: id('mat'), f1Own: id('mat'), hockeyDone: id('mat'), hockeyOwn: id('mat') };
  const r = { public: id('room'), own: id('room'), f1: id('room'), hockey: id('room'), follower: id('room'), demo: id('room') };
  const msg = { byDemo: id('msg'), reply: id('msg'), kept: id('msg'), inDemoRoom: id('msg') };
  const thread = id('thr');
  const poll = id('pol');
  const inv = { toDemo: id('inv'), fromDemo: id('inv'), real: id('inv') };

  await db.query(`INSERT INTO users (id, handle, is_demo) VALUES ($1, 'mig_owner', false), ($2, 'mig_friend', false), ($3, 'demo_aarav', true)`, [owner, friend, demo]);
  const run = (matchId: string, fixture: string, status: string, roomId: string | null, age: string) => db.query(
    `INSERT INTO matches (id, fixture_key, title, team_a, team_b, source, status, feed_started_at, ball_interval_ms, room_id, paused_at, created_at)
     VALUES ($1, $2, 'Game', 'A', 'B', 'demo_fixture', $3, now() - $5::interval, 10000, $4, CASE WHEN $4::text IS NULL THEN NULL ELSE now() END, now() - $5::interval)`,
    [matchId, fixture, status, roomId, age]);
  await run(m.cricket, 'mi-csk-demo', 'live', null, '1 hour');
  await run(m.cricketDone, 'mi-csk-demo', 'completed', null, '10 minutes'); // newer, but finished: not preferred
  await run(m.cricketOwn, 'mi-csk-demo', 'live', r.own, '5 minutes');
  await run(m.f1Own, 'f1-monza-demo', 'scheduled', r.f1, '5 minutes'); // no shared F1 run at all
  await run(m.hockeyDone, 'nhl-edm-tor-demo', 'completed', null, '2 hours'); // the only shared hockey run
  await run(m.hockeyOwn, 'nhl-edm-tor-demo', 'live', r.hockey, '5 minutes');
  await db.query(`INSERT INTO rooms (id, name, room_type, match_id) VALUES ($1, 'MI v CSK · Public watch party', 'public', $2)`, [r.public, m.cricket]);
  for (const [roomId, creator, matchId] of [[r.own, owner, m.cricketOwn], [r.f1, owner, m.f1Own], [r.hockey, owner, m.hockeyOwn], [r.follower, friend, m.cricket], [r.demo, demo, m.cricket]]) {
    await db.query(`INSERT INTO rooms (id, name, room_type, creator_id, match_id, moderation_level) VALUES ($1, 'Friends', 'private', $2, $3, 'balanced')`, [roomId, creator, matchId]);
  }
  await db.query(`INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member'), ($1, $4, 'member'), ($5, $4, 'owner')`,
    [r.own, owner, friend, demo, r.demo]);
  await db.query(
    `INSERT INTO room_invitations (id, room_id, inviter_id, invitee_id, status, expires_at) VALUES
       ($1, $4, $6, $7, 'pending', now() + interval '1 day'),
       ($2, $5, $7, $8, 'pending', now() + interval '1 day'),
       ($3, $9, $6, $8, 'pending', now() + interval '1 day')`,
    [inv.toDemo, inv.fromDemo, inv.real, r.own, r.follower, owner, demo, friend, r.f1]);
  await db.query(`INSERT INTO room_threads (id, room_id, slug, title, source) VALUES ($1, $2, 'dube-out', '#dube-out', 'moment')`, [thread, r.demo]);
  await db.query(
    `INSERT INTO messages (id, room_id, seq, sender_type, sender_id, body, status, reply_to_id, thread_id) VALUES
       ($1, $5, 1, 'user', $6, 'hello from a demo friend', 'visible', NULL, NULL),
       ($2, $5, 2, 'user', $7, 'hi!', 'visible', $1, NULL),
       ($3, $5, 3, 'user', $8, 'kept', 'visible', NULL, NULL),
       ($4, $9, 1, 'user', $6, 'in their own room', 'visible', NULL, $10)`,
    [msg.byDemo, msg.reply, msg.kept, msg.inDemoRoom, r.own, demo, friend, owner, r.demo, thread]);
  await db.query(`INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, '🔥'), ($1, $3, '👏')`, [msg.kept, demo, friend]);
  await db.query(`INSERT INTO polls (id, room_id, seq, question, options, source, requested_by, idempotency_key, status, closes_at)
                  VALUES ($1, $2, 4, 'Who wins?', '[{"label":"MI"},{"label":"CSK"}]', 'template', $3, 'k1', 'open', now() + interval '1 minute')`, [poll, r.own, demo]);
  await db.query(`INSERT INTO reports (id, kind, room_id, reporter_id, message_id, reason, status) VALUES ($1, 'message', $2, $3, $4, 'spam', 'open')`, [id('rep'), r.own, demo, msg.kept]);
  await db.query('INSERT INTO notification_prefs (user_id) VALUES ($1), ($2)', [owner, demo]);
  await db.query(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES ($1, $2, 'https://push.example.test/owner', 'p', 'a')`, [id('psub'), owner]);
  await db.query(`INSERT INTO notification_deliveries (id, dedupe_key, recipient_id, room_id, kind, priority, channel, status, expires_at)
                  VALUES ($1, 'invite:x', $2, $3, 'invite', 'medium', 'push', 'queued', now() + interval '1 hour')`, [id('ntf'), owner, r.own]);
  await db.query(`INSERT INTO jobs (id, type, dedupe_key, payload, status) VALUES
                    ($1, 'push_delivery', 'push:1', '{}', 'queued'), ($2, 'push_invite', 'invite:1', '{}', 'queued'), ($3, 'poll_close', 'pollclose:1', '{}', 'queued')`,
  [id('job'), id('job'), id('job')]);

  await migrate(db);

  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const all = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  assert.ok((await all('SELECT version FROM schema_migrations')).some((v) => v.version === '013_shared_games_only'));

  // Rooms follow the newest shared run of their game, live or scheduled first; with none, no game.
  const followed = async (roomId: string) => (await one('SELECT match_id FROM rooms WHERE id = $1', [roomId])).match_id;
  assert.equal(await followed(r.own), m.cricket);
  assert.equal(await followed(r.f1), null);
  assert.equal(await followed(r.hockey), m.hockeyDone);
  assert.equal(await followed(r.follower), m.cricket);
  assert.equal(await followed(r.public), m.cricket);
  const statuses = Object.fromEntries((await all('SELECT id, status, completed_at IS NOT NULL AS closed FROM matches')).map((x) => [x.id, [x.status, x.closed]]));
  for (const own of [m.cricketOwn, m.f1Own, m.hockeyOwn]) assert.deepEqual(statuses[own], ['completed', true]);
  assert.deepEqual(statuses[m.cricket], ['live', false]);

  // Columns and tables that are gone.
  const columns = await all(`SELECT table_name, column_name FROM information_schema.columns
                              WHERE (table_name = 'matches' AND column_name IN ('room_id', 'paused_at')) OR (table_name = 'users' AND column_name = 'is_demo')`);
  assert.deepEqual(columns, []);
  for (const table of ['notification_deliveries', 'push_subscriptions', 'notification_prefs']) {
    assert.equal((await one('SELECT to_regclass($1) AS t', [table])).t, null, table);
  }
  assert.equal((await one(`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname IN ('matches_room_idx', 'push_subscriptions_user', 'notification_deliveries_created')`)).n, 0);
  assert.deepEqual((await all('SELECT type FROM jobs ORDER BY type')).map((j) => j.type), ['poll_close']);

  // The demo friend is gone, with everything that pointed at them; real people keep theirs.
  assert.deepEqual((await all('SELECT id FROM users ORDER BY handle')).map((u) => u.id), [friend, owner]);
  assert.deepEqual((await all('SELECT id FROM room_invitations')).map((i) => i.id), [inv.real]);
  assert.deepEqual((await all('SELECT id, reply_to_id FROM messages ORDER BY seq')), [{ id: msg.reply, reply_to_id: null }, { id: msg.kept, reply_to_id: null }]);
  assert.deepEqual((await all('SELECT user_id FROM message_reactions')).map((x) => x.user_id), [friend]);
  assert.equal((await one('SELECT requested_by FROM polls WHERE id = $1', [poll])).requested_by, null);
  assert.equal((await one('SELECT count(*)::int AS n FROM reports')).n, 0);
  assert.equal(await one('SELECT id FROM rooms WHERE id = $1', [r.demo]), undefined);
  assert.equal((await one('SELECT count(*)::int AS n FROM room_threads')).n, 0);
  assert.deepEqual((await all('SELECT user_id FROM room_members ORDER BY user_id')).map((x) => x.user_id).sort(), [friend, owner].sort());

  // Today's code reads the migrated database.
  const snap = await matchSnapshot(db, m.cricket, { detail: true });
  assert.equal(snap?.match.id, m.cricket);
  await db.close();
});

// Migration 014 on a database as release 013 left it: Formula 1 and ice hockey runs with rooms on them, and fans who
// backed teams in those sports.
test('migration 014 ends the rooms on the retired sports, closes their runs and forgets those picks', async () => {
  const db = await openPglite(null);
  await migrate(db, { upTo: 13 });
  const id = (prefix: string) => newId(prefix);
  const [owner, friend] = [id('usr'), id('usr')];
  const m = { f1: id('mat'), hockeyDone: id('mat'), hockeyLive: id('mat'), cricket: id('mat') };
  const r = { f1Public: id('room'), hockeyOwn: id('room'), hockeyPublic: id('room'), cricket: id('room'), ended: id('room') };
  const [inv, job, otherJob] = [id('inv'), id('job'), id('job')];

  await db.query(`INSERT INTO users (id, handle, sports) VALUES ($1, 'mig_fan', $3::jsonb), ($2, 'mig_mate', '{}'::jsonb)`, [owner, friend,
    JSON.stringify({ cricket: { team: 'CSK', picks: ['MS Dhoni'] }, f1: { team: 'MCL', picks: ['Lando Norris'] }, hockey: { team: null, picks: [] } })]);
  const run = (matchId: string, fixture: string, status: string) => db.query(
    `INSERT INTO matches (id, fixture_key, title, team_a, team_b, source, status, feed_started_at, ball_interval_ms)
     VALUES ($1, $2, 'Game', 'A', 'B', 'demo_fixture', $3, now(), 10000)`, [matchId, fixture, status]);
  await run(m.f1, 'f1-monza-demo', 'live');
  await run(m.hockeyDone, 'nhl-edm-tor-demo', 'completed');
  await run(m.hockeyLive, 'nhl-edm-tor-demo', 'scheduled');
  await run(m.cricket, 'mi-csk-demo', 'live');
  for (const [roomId, matchId] of [[r.f1Public, m.f1], [r.hockeyPublic, m.hockeyLive]]) {
    await db.query(`INSERT INTO rooms (id, name, room_type, match_id) VALUES ($1, 'Public watch party', 'public', $2)`, [roomId, matchId]);
  }
  for (const [roomId, matchId] of [[r.hockeyOwn, m.hockeyDone], [r.cricket, m.cricket], [r.ended, m.f1]]) {
    await db.query(`INSERT INTO rooms (id, name, room_type, creator_id, match_id, moderation_level) VALUES ($1, 'Friends', 'private', $2, $3, 'balanced')`, [roomId, owner, matchId]);
  }
  await db.query(`UPDATE rooms SET status = 'ended', ended_at = now() - interval '1 hour', end_reason = 'ended_by_owner', purge_after = now() + interval '1 hour' WHERE id = $1`, [r.ended]);
  await db.query(`INSERT INTO room_invitations (id, room_id, inviter_id, invitee_id, status, expires_at) VALUES ($1, $2, $3, $4, 'pending', now() + interval '1 day')`,
    [inv, r.hockeyOwn, owner, friend]);
  await db.query(`INSERT INTO room_presence (room_id, user_id, state) VALUES ($1, $3, 'active'), ($2, $3, 'active')`, [r.f1Public, r.cricket, owner]);
  await db.query(`INSERT INTO jobs (id, type, room_id, dedupe_key, status) VALUES ($1, 'poll_close', $3, 'pollclose:a', 'queued'), ($2, 'poll_close', $4, 'pollclose:b', 'queued')`,
    [job, otherJob, r.hockeyOwn, r.cricket]);

  await migrate(db);

  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  assert.ok(await one(`SELECT 1 FROM schema_migrations WHERE version = '014_kabaddi_football'`));
  // Rooms on any run of the retired sports end like a normal end, and the sweep purges them after the retention window.
  for (const roomId of [r.f1Public, r.hockeyPublic, r.hockeyOwn]) {
    const room = await one(`SELECT status, end_reason, ended_at IS NOT NULL AS ended, purge_after > now() + interval '23 hours' AS later FROM rooms WHERE id = $1`, [roomId]);
    assert.deepEqual(room, { status: 'ended', end_reason: 'sport_retired', ended: true, later: true }, roomId);
  }
  assert.equal((await one('SELECT end_reason FROM rooms WHERE id = $1', [r.ended])).end_reason, 'ended_by_owner'); // already ended: untouched
  assert.equal((await one('SELECT status FROM rooms WHERE id = $1', [r.cricket])).status, 'active');
  assert.equal((await one('SELECT status FROM room_invitations WHERE id = $1', [inv])).status, 'expired');
  assert.deepEqual((await db.query('SELECT room_id FROM room_presence')).rows.map((p) => p.room_id), [r.cricket]);
  assert.equal((await one('SELECT status FROM jobs WHERE id = $1', [job])).status, 'cancelled');
  assert.equal((await one('SELECT status FROM jobs WHERE id = $1', [otherJob])).status, 'queued');
  // Their runs close; other sports play on.
  const statuses = Object.fromEntries((await db.query('SELECT id, status, completed_at IS NOT NULL AS closed FROM matches')).rows.map((x) => [x.id, [x.status, x.closed]]));
  for (const done of [m.f1, m.hockeyLive]) assert.deepEqual(statuses[done], ['completed', true]);
  assert.deepEqual(statuses[m.cricket], ['live', false]);
  // Fans keep only the sports Huddle still has.
  assert.deepEqual((await one('SELECT sports FROM users WHERE id = $1', [owner])).sports, { cricket: { team: 'CSK', picks: ['MS Dhoni'] } });
  assert.deepEqual((await one('SELECT sports FROM users WHERE id = $1', [friend])).sports, {});
  await db.close();
});
