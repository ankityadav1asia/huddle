-- Kabaddi and football replace Formula 1 and ice hockey. Their fixtures were 'f1-monza-demo' and 'nhl-edm-tor-demo';
-- the code no longer knows them, so rooms that follow their runs end and the runs close.

-- 1. Active rooms (public or private) on a run of the old fixtures end as lib/rooms/lifecycle.ts endRoom ends them:
--    queued room jobs cancelled, pending invitations expired, presence cleared, then the room ended now with a purge
--    after the default 24h retention (the sweep's backstop queues the purge). The room goes last: the others find
--    it by its active status.
UPDATE jobs SET status = 'cancelled', finished_at = now(), locked_until = NULL, last_error = 'room_ended', updated_at = now()
 WHERE status IN ('queued', 'running') AND room_id IN (
   SELECT r.id FROM rooms r JOIN matches m ON m.id = r.match_id
    WHERE r.status = 'active' AND m.fixture_key IN ('f1-monza-demo', 'nhl-edm-tor-demo'));
UPDATE room_invitations SET status = 'expired'
 WHERE status = 'pending' AND room_id IN (
   SELECT r.id FROM rooms r JOIN matches m ON m.id = r.match_id
    WHERE r.status = 'active' AND m.fixture_key IN ('f1-monza-demo', 'nhl-edm-tor-demo'));
DELETE FROM room_presence WHERE room_id IN (
  SELECT r.id FROM rooms r JOIN matches m ON m.id = r.match_id
   WHERE r.status = 'active' AND m.fixture_key IN ('f1-monza-demo', 'nhl-edm-tor-demo'));
UPDATE rooms r SET status = 'ended', ended_at = now(), end_reason = 'sport_retired', updated_at = now(),
                   purge_after = now() + interval '24 hours'
  FROM matches m
 WHERE m.id = r.match_id AND r.status = 'active' AND m.fixture_key IN ('f1-monza-demo', 'nhl-edm-tor-demo');

-- 2. Their runs close, so the feed stops playing them and the home screen stops listing them.
UPDATE matches SET status = 'completed', completed_at = COALESCE(completed_at, now())
 WHERE fixture_key IN ('f1-monza-demo', 'nhl-edm-tor-demo') AND status <> 'completed';

-- 3. Fans' teams and players for the retired sports.
UPDATE users SET sports = sports - 'f1' - 'hockey' WHERE sports ?| array['f1', 'hockey'];
