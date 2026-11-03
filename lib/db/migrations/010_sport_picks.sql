-- A fan's team and players for each sport: { "<sport>": { "team": "<code>" | null, "picks": ["<player>", ...] } }.
-- A sport present with a null team means the fan chose to back nobody there. Cricket's choice moves here from
-- users.team / users.picks, which are no longer read (left in place so instances still on the old code keep working
-- during a deploy; a later migration can drop them).
ALTER TABLE users ADD COLUMN sports jsonb NOT NULL DEFAULT '{}'::jsonb;
UPDATE users SET sports = jsonb_build_object('cricket', jsonb_build_object('team', team, 'picks', to_jsonb(picks)))
 WHERE team IS NOT NULL OR cardinality(picks) > 0;
