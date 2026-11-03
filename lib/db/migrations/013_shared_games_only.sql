-- The 3 November 2026 redesign: every room follows the shared game of its sport (private rooms' own runs and their
-- controls are gone), push notifications are gone, and so are the demo friends.

-- 1. A room on a room-owned run (a private room's own copy of a game) moves to the newest shared run of the same
--    fixture, a scheduled or live one if there is one. With no shared run of that fixture at all, it follows no game.
UPDATE rooms r SET match_id = (
  SELECT s.id FROM matches s
   WHERE s.room_id IS NULL AND s.fixture_key = own.fixture_key
   ORDER BY (s.status IN ('scheduled', 'live')) DESC, s.created_at DESC
   LIMIT 1)
  FROM matches own
 WHERE own.id = r.match_id AND own.room_id IS NOT NULL;

-- Nobody follows those runs any more: close them so the feed stops playing them. An auto-end still queued for one is
-- ignored, because its room no longer follows it (lib/jobs/worker.ts).
UPDATE matches SET status = 'completed', completed_at = COALESCE(completed_at, now()) WHERE room_id IS NOT NULL;

ALTER TABLE matches DROP COLUMN IF EXISTS room_id; -- drops its index, matches_room_idx, too
ALTER TABLE matches DROP COLUMN IF EXISTS paused_at;

-- 2. Push notifications: their tables (their indexes go with them) and any delivery jobs still queued.
DROP TABLE IF EXISTS notification_deliveries;
DROP TABLE IF EXISTS push_subscriptions;
DROP TABLE IF EXISTS notification_prefs;
DELETE FROM jobs WHERE type IN ('push_invite', 'push_delivery');

-- 3. The demo friends (users.is_demo). Nobody could sign in as them, so in practice they were only ever invited; the
--    other deletes guard every reference to users without ON DELETE CASCADE: room_invitations (inviter, invitee),
--    polls.requested_by, reports.reporter_id, messages.sender_id and rooms.creator_id. Sessions, memberships,
--    presence, reactions, poll votes and cooldowns go with the user.
DELETE FROM room_invitations
 WHERE inviter_id IN (SELECT id FROM users WHERE is_demo) OR invitee_id IN (SELECT id FROM users WHERE is_demo);
UPDATE polls SET requested_by = NULL WHERE requested_by IN (SELECT id FROM users WHERE is_demo);
DELETE FROM reports WHERE reporter_id IN (SELECT id FROM users WHERE is_demo);
DELETE FROM messages WHERE sender_id IN (SELECT id FROM users WHERE is_demo);

-- A private room cannot lose its creator, so a room a demo friend created goes. room_threads has no ON DELETE
-- CASCADE and messages point at threads: messages, then threads, then the room (which takes the rest with it).
DELETE FROM messages WHERE room_id IN (SELECT id FROM rooms WHERE creator_id IN (SELECT id FROM users WHERE is_demo));
DELETE FROM room_threads WHERE room_id IN (SELECT id FROM rooms WHERE creator_id IN (SELECT id FROM users WHERE is_demo));
DELETE FROM rooms WHERE creator_id IN (SELECT id FROM users WHERE is_demo);

DELETE FROM users WHERE is_demo;
ALTER TABLE users DROP COLUMN IF EXISTS is_demo;
