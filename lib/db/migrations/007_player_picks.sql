-- Up to three players a fan picks when joining (their contest team), from the demo squads. Public, like the team.
ALTER TABLE users ADD COLUMN picks text[] NOT NULL DEFAULT '{}';
