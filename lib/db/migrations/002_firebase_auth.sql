-- Firebase Phone Auth: remember which Firebase user proved each phone number (for audit and support).
ALTER TABLE users ADD COLUMN firebase_uid text;
CREATE UNIQUE INDEX users_firebase_uid ON users (firebase_uid) WHERE firebase_uid IS NOT NULL;
