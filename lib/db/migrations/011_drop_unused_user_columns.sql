-- Columns no code reads: phone_e164 from the removed phone sign-in, and team/picks, which migration 010 copied into
-- users.sports. Dropping phone_e164 also removes any phone numbers kept from that time.
ALTER TABLE users DROP COLUMN IF EXISTS phone_e164;
ALTER TABLE users DROP COLUMN IF EXISTS team;
ALTER TABLE users DROP COLUMN IF EXISTS picks;
