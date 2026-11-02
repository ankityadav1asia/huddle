-- Demo friends: seeded profiles (clearly labelled) so the invitation flow can be shown without a second person.
-- Nobody can sign in as them; invitations to them stay pending until they expire.
ALTER TABLE users ADD COLUMN is_demo boolean NOT NULL DEFAULT false;
