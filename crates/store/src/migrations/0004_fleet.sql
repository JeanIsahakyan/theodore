-- Spaces this device hosts for the fleet (docs/fleet.md "App side"), and
-- their journaled events for replay. Not models: never synced.
CREATE TABLE fleet_spaces (
  space         TEXT PRIMARY KEY,
  local_space   TEXT NOT NULL,
  origin_device TEXT NOT NULL,
  parent        TEXT,
  depth         INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  -- The core's bookkeeping: mode, project, what was last reported.
  data          TEXT NOT NULL
);
CREATE INDEX fleet_spaces_by_local ON fleet_spaces(local_space);
CREATE TABLE fleet_events (
  space TEXT NOT NULL,
  seq   INTEGER NOT NULL,
  event TEXT NOT NULL,
  PRIMARY KEY (space, seq)
);
