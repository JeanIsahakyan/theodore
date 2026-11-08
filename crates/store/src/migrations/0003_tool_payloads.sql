-- What each tool call of a space turn took and gave, for its row to show when
-- it is opened. Not a model: never synced, never in a bootstrap.
CREATE TABLE tool_payloads (
  run   TEXT NOT NULL,
  call  TEXT NOT NULL,
  space TEXT NOT NULL,
  -- An object by part: input, result, report, ended.
  data  TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  PRIMARY KEY (run, call)
);
CREATE INDEX tool_payloads_by_space ON tool_payloads(space);
