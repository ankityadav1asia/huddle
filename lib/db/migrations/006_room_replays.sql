-- A private room can run its own copy of the simulated replay, which only its owner and admins control.
-- room_id marks such a run (NULL for the shared replay that the public watch party follows), and
-- paused_at is set while its host has it paused.
ALTER TABLE matches ADD COLUMN room_id text;
ALTER TABLE matches ADD COLUMN paused_at timestamptz;
CREATE INDEX matches_room_idx ON matches (room_id) WHERE room_id IS NOT NULL;
