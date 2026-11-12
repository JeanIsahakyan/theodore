-- Fleet requests this device has verified (docs/fleet.md "This device as
-- the target"): kept past a restart so a re-delivered request that already
-- ran is refused as a replay. `done` 0: claimed, no claim result yet.
CREATE TABLE fleet_seen (
  req_id    TEXT PRIMARY KEY,
  issued_at INTEGER NOT NULL,
  done      INTEGER NOT NULL
);
CREATE INDEX fleet_seen_by_issued_at ON fleet_seen(issued_at);
