-- People appear by username only since one-tap join; nothing writes or reads display names.
ALTER TABLE users DROP COLUMN IF EXISTS display_name;
