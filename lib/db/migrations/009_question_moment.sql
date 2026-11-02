-- The match moment a message was sent at: the newest feed item of the room's match at that instant. The AI Co-host
-- answers a question about the game as it stood when it was asked, not only as it is when the answer is written.
ALTER TABLE messages ADD COLUMN match_seq integer;
