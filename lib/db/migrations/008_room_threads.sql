-- Moment threads: #topics inside a room. The match opens one for each big moment (a wicket, the bowling change, the
-- DRS call, a dropped catch, the last over, the result) and the room opens one when people keep arguing about the
-- same topic. Room content: purged with the room's messages.
CREATE TABLE room_threads (
  id             text PRIMARY KEY,
  room_id        text NOT NULL REFERENCES rooms(id),
  slug           text NOT NULL,
  title          text NOT NULL,
  about          text,
  keywords       text[] NOT NULL DEFAULT '{}',
  source         text NOT NULL CHECK (source IN ('moment', 'discussion')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, slug)
);
ALTER TABLE messages ADD COLUMN thread_id text REFERENCES room_threads(id);
CREATE INDEX messages_thread_idx ON messages (thread_id) WHERE thread_id IS NOT NULL;
