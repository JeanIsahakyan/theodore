/**
 * The OrgHub's SQLite (Durable Object `ctx.storage.sql`; node:sqlite in
 * tests). One database per org; every row carries the user it belongs to.
 *
 * ```text
 * devices  device_id ─ user, pinned public key, info, generation, last seen
 * spaces   space ─ user, host, origin, parent, depth, last seq, status,
 *          last activity, the started event's envelope
 * events   (space, seq) ─ the host's signed envelope, last CLOUD_RING per space
 * pending  req_id ─ a routed request until its reply (or 2 min)
 * replies  req_id ─ a reply held for an origin that's offline (2 min)
 * asks     ask_id ─ an open question (the host's envelope): where it shows
 * subs     (device, space) ─ who gets a space's live events
 * conns    conn_id ─ a deadline: hello due, or access token expiry + 60 s
 * meta     schema ─ SCHEMA_VERSION; on any other, every table but devices
 *          and conns is dropped (v1 rows don't fit v2: unsigned events)
 * ```
 */
import { CLOUD_RING } from './limits';

export type SqlValue = string | number | null;

/** The part of `SqlStorage` the hub uses: run a statement, get the rows. */
export interface Sql {
  exec(query: string, ...binds: SqlValue[]): Record<string, unknown>[];
}

export const SCHEMA_VERSION = 2;

/** Relay state that a schema change throws away; devices stay pinned. */
const RESET = ['spaces', 'events', 'pending', 'replies', 'asks', 'subs'];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS devices (
    device_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    info TEXT NOT NULL,
    generation INTEGER NOT NULL,
    last_seen_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS devices_user ON devices (user_id, public_key)`,
  `CREATE TABLE IF NOT EXISTS spaces (
    space TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    host_device TEXT NOT NULL,
    origin_device TEXT NOT NULL,
    parent TEXT,
    depth INTEGER NOT NULL,
    last_seq INTEGER NOT NULL DEFAULT 0,
    status TEXT,
    last_ms INTEGER NOT NULL,
    started TEXT,
    started_seq INTEGER)`,
  `CREATE INDEX IF NOT EXISTS spaces_host ON spaces (host_device)`,
  `CREATE INDEX IF NOT EXISTS spaces_user ON spaces (user_id, last_ms)`,
  `CREATE INDEX IF NOT EXISTS spaces_parent ON spaces (parent)`,
  `CREATE TABLE IF NOT EXISTS events (
    space TEXT NOT NULL,
    seq INTEGER NOT NULL,
    envelope TEXT NOT NULL,
    PRIMARY KEY (space, seq))`,
  `CREATE TABLE IF NOT EXISTS pending (
    req_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    origin_device TEXT NOT NULL,
    target_device TEXT NOT NULL,
    generation INTEGER NOT NULL,
    claimed INTEGER NOT NULL DEFAULT 0,
    created_ms INTEGER NOT NULL,
    grace_until INTEGER,
    envelope TEXT NOT NULL,
    op TEXT NOT NULL,
    space TEXT NOT NULL,
    parent TEXT,
    depth INTEGER NOT NULL,
    ask_id TEXT)`,
  `CREATE INDEX IF NOT EXISTS pending_target ON pending (target_device)`,
  `CREATE TABLE IF NOT EXISTS replies (
    req_id TEXT PRIMARY KEY,
    origin_device TEXT NOT NULL,
    outcome TEXT NOT NULL,
    created_ms INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS asks (
    ask_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    space TEXT NOT NULL,
    host_device TEXT NOT NULL,
    origin_device TEXT NOT NULL,
    envelope TEXT NOT NULL,
    shown_on TEXT NOT NULL,
    via TEXT,
    escalated INTEGER NOT NULL DEFAULT 0,
    created_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS asks_user ON asks (user_id)`,
  `CREATE INDEX IF NOT EXISTS asks_space ON asks (space)`,
  `CREATE TABLE IF NOT EXISTS subs (
    device_id TEXT NOT NULL,
    space TEXT NOT NULL,
    PRIMARY KEY (device_id, space))`,
  `CREATE INDEX IF NOT EXISTS subs_space ON subs (space)`,
  `CREATE TABLE IF NOT EXISTS conns (
    conn_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    deadline_ms INTEGER NOT NULL)`,
];

export interface DeviceRow {
  device_id: string;
  user_id: string;
  public_key: string;
  info: string;
  generation: number;
  last_seen_ms: number;
}

export interface SpaceRow {
  space: string;
  user_id: string;
  host_device: string;
  origin_device: string;
  parent: string | null;
  depth: number;
  last_seq: number;
  status: string | null;
  last_ms: number;
  /** The `started` event's envelope JSON, kept past the ring. */
  started: string | null;
  started_seq: number | null;
}

export interface PendingRow {
  req_id: string;
  user_id: string;
  origin_device: string;
  target_device: string;
  generation: number;
  claimed: number;
  created_ms: number;
  grace_until: number | null;
  envelope: string;
  op: string;
  space: string;
  parent: string | null;
  depth: number;
  ask_id: string | null;
}

export interface AskRow {
  ask_id: string;
  user_id: string;
  space: string;
  host_device: string;
  origin_device: string;
  /** The host's signed RemoteAsk, as JSON of the envelope. */
  envelope: string;
  shown_on: string;
  via: string | null;
  escalated: number;
  created_ms: number;
}

/** Typed queries over [`Sql`]. */
export class Store {
  constructor(readonly sql: Sql) {
    sql.exec(
      'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)',
    );
    const v = this.num("SELECT v FROM meta WHERE k = 'schema'");
    if (v !== SCHEMA_VERSION) {
      for (const t of RESET) sql.exec(`DROP TABLE IF EXISTS ${t}`);
    }
    for (const s of SCHEMA) sql.exec(s);
    sql.exec(
      `INSERT INTO meta (k, v) VALUES ('schema', ?)
       ON CONFLICT (k) DO UPDATE SET v = excluded.v`,
      SCHEMA_VERSION,
    );
  }

  rows<T>(q: string, ...b: SqlValue[]): T[] {
    return this.sql.exec(q, ...b) as T[];
  }

  one<T>(q: string, ...b: SqlValue[]): T | undefined {
    return this.rows<T>(q, ...b)[0];
  }

  run(q: string, ...b: SqlValue[]): void {
    this.sql.exec(q, ...b);
  }

  num(q: string, ...b: SqlValue[]): number | null {
    const row = this.sql.exec(q, ...b)[0];
    const v = row ? Object.values(row)[0] : null;
    return typeof v === 'number' ? v : null;
  }

  device(id: string | undefined): DeviceRow | undefined {
    return id === undefined
      ? undefined
      : this.one<DeviceRow>('SELECT * FROM devices WHERE device_id = ?', id);
  }

  space(id: string): SpaceRow | undefined {
    return this.one<SpaceRow>('SELECT * FROM spaces WHERE space = ?', id);
  }

  pending(id: string): PendingRow | undefined {
    return this.one<PendingRow>('SELECT * FROM pending WHERE req_id = ?', id);
  }

  ask(id: string): AskRow | undefined {
    return this.one<AskRow>('SELECT * FROM asks WHERE ask_id = ?', id);
  }

  /** Stores an event's envelope JSON; keeps the newest CLOUD_RING. */
  addEvent(space: string, seq: number, envelope: string): void {
    this.run(
      'INSERT OR IGNORE INTO events (space, seq, envelope) VALUES (?, ?, ?)',
      space,
      seq,
      envelope,
    );
    // With fewer than CLOUD_RING, the subquery is NULL.
    this.run(
      `DELETE FROM events WHERE space = ? AND seq < (
         SELECT seq FROM events WHERE space = ?
         ORDER BY seq DESC LIMIT 1 OFFSET ?)`,
      space,
      space,
      CLOUD_RING - 1,
    );
  }

  /** Forgets spaces: their events, subscriptions and the spaces rows. */
  dropSpaces(spaces: string[]): void {
    for (const sp of spaces) {
      this.run('DELETE FROM events WHERE space = ?', sp);
      this.run('DELETE FROM subs WHERE space = ?', sp);
      this.run('DELETE FROM spaces WHERE space = ?', sp);
    }
  }

  setDeadline(connId: string, userId: string, at: number): void {
    this.run(
      `INSERT INTO conns (conn_id, user_id, deadline_ms) VALUES (?, ?, ?)
       ON CONFLICT (conn_id) DO UPDATE SET deadline_ms = excluded.deadline_ms`,
      connId,
      userId,
      at,
    );
  }
}
