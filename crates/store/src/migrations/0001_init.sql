-- Initial schema: model rows, sync log, outbox, kv, seen transactions.
-- `schema_version` itself is created by the migration runner, not here.

CREATE TABLE models (
    model TEXT NOT NULL,
    id TEXT NOT NULL,
    data TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    updated_sync_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (model, id)
);

CREATE INDEX idx_models_model_archived ON models (model, archived);

-- Example JSON index for a common query field (plan §9): rows that belong to
-- a PR. Add one of these per hot field as query() call sites appear.
CREATE INDEX idx_models_pr ON models (model, json_extract(data, '$.pr'));

CREATE TABLE sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model TEXT NOT NULL,
    model_id TEXT NOT NULL,
    action TEXT NOT NULL,
    data TEXT,
    at INTEGER NOT NULL
);

CREATE TABLE outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    op TEXT NOT NULL,
    payload TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    not_before INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX idx_outbox_pending ON outbox (status, not_before, id);

CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE tx_seen (
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL
);
