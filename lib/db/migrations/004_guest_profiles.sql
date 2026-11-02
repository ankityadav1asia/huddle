-- Phone sign-in was removed in favour of guest profiles (name + handle, kept by a session cookie).
-- Existing rows keep their phone numbers; new profiles have none. The OTP table is no longer used.
ALTER TABLE users ALTER COLUMN phone_e164 DROP NOT NULL;
DROP TABLE IF EXISTS otp_challenges;
