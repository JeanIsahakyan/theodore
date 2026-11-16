/**
 * The OrgHub's SQLite (Durable Object `ctx.storage.sql`; node:sqlite in
 * tests). One database per org; every row carries the user it belongs to.
 *
 * ```text
 * devices  device_id ─ user, pinned public key, info, generation, last seen
 * spaces   space ─ user, host, origin, parent, depth, last seq, status,
 *          last activity, the started event's envelope, stored event and
 *          mirror bytes, the last seq lost, the start request that made it
 * events   (space, seq) ─ the host's signed envelope and its body's bytes;
 *          the newest CLOUD_RING per space, within MAX_SPACE_EVENT_BYTES
 *          with its mirrors
 * mirrors  (space, model, id) ─ the latest `mirror` event of a `space` or
 *          `chat_message` row (a tombstone too): seq, envelope, bytes
 * pending  req_id ─ a routed request until its reply (or 2 min)
 * replies  req_id ─ a reply or refusal held for an origin that's offline
 *          (2 min), as the frame to send
 * asks     ask_id ─ an open question (the host's envelope): where it shows,
 *          which devices were pushed about it
 * subs     (device, space) ─ who gets a space's live events
 * conns    conn_id ─ a deadline: hello due, or access token expiry + 60 s
 * push_tokens  device_id ─ its Expo push token, this minute's push count
 * delegations  (origin, delegate) ─ the origin's latest signed delegation;
 *          a revocation stays as a tombstone for the 5 min freshness window
 * meta     schema ─ SCHEMA_VERSION; on any other, every table but devices,
 *          conns, push_tokens and delegations is dropped (older rows carry
 *          older signatures)
 * ```
 */
import { CLOUD_RING, MAX_SPACE_EVENT_BYTES } from './limits';

export type SqlValue = string | number | null;

/** The part of `SqlStorage` the hub uses: run a statement, get the rows. */
export interface Sql {
  exec(query: string, ...binds: SqlValue[]): Record<string, unknown>[];
}

export const SCHEMA_VERSION = 6;

/** Relay state that a schema change throws away; devices stay pinned. */
const RESET = [
  'spaces',
  'events',
  'mirrors',
  'pending',
  'replies',
  'asks',
  'subs',
];

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
    started_seq INTEGER,
    bytes INTEGER NOT NULL DEFAULT 0,
    started_bytes INTEGER NOT NULL DEFAULT 0,
    mirror_bytes INTEGER NOT NULL DEFAULT 0,
    lost_to INTEGER NOT NULL DEFAULT 0,
    req_id TEXT)`,
  `CREATE INDEX IF NOT EXISTS spaces_host ON spaces (host_device)`,
  `CREATE INDEX IF NOT EXISTS spaces_user ON spaces (user_id, last_ms)`,
  `CREATE INDEX IF NOT EXISTS spaces_parent ON spaces (parent)`,
  `CREATE TABLE IF NOT EXISTS events (
    space TEXT NOT NULL,
    seq INTEGER NOT NULL,
    envelope TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    PRIMARY KEY (space, seq))`,
  `CREATE TABLE IF NOT EXISTS mirrors (
    space TEXT NOT NULL,
    model TEXT NOT NULL,
    id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    envelope TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    PRIMARY KEY (space, model, id))`,
  `CREATE INDEX IF NOT EXISTS mirrors_seq ON mirrors (space, seq)`,
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
    message TEXT NOT NULL,
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
    created_ms INTEGER NOT NULL,
    pushed TEXT NOT NULL DEFAULT '[]')`,
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
  `CREATE TABLE IF NOT EXISTS push_tokens (
    device_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    token TEXT NOT NULL,
    window_ms INTEGER NOT NULL DEFAULT 0,
    sent INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS delegations (
    origin_device TEXT NOT NULL,
    delegate_device TEXT NOT NULL,
    user_id TEXT NOT NULL,
    envelope TEXT NOT NULL,
    issued_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    revoked INTEGER NOT NULL,
    PRIMARY KEY (origin_device, delegate_device))`,
  `CREATE INDEX IF NOT EXISTS delegations_delegate ON delegations (delegate_device)`,
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
  /** Body bytes of its events in the ring. */
  bytes: number;
  /** Body bytes of `started`. */
  started_bytes: number;
  /** Body bytes of its kept mirrors. */
  mirror_bytes: number;
  /**
   * Every hole in seq at or below this is real loss (the ring's oldest
   * dropped, a protocol-3 host's jump): history reports it as a gap. Holes
   * above it are compaction or relayed-only `turn_step`s.
   */
  lost_to: number;
  /** The start request that made the row (its claim). */
  req_id: string | null;
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
  /** Devices pushed about it (JSON list): one push per device. */
  pushed: string;
}

export interface PushTokenRow {
  device_id: string;
  user_id: string;
  provider: string;
  token: string;
  /** Start of the current one-minute window, unix ms. */
  window_ms: number;
  /** Pushes sent in it. */
  sent: number;
}

export interface DelegationRow {
  origin_device: string;
  delegate_device: string;
  user_id: string;
  /** The origin's signed envelope, as JSON. */
  envelope: string;
  issued_at_ms: number;
  /** 0: no expiry. */
  expires_at_ms: number;
  /** 1: a revocation, kept to refuse an older grant replayed. */
  revoked: number;
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

  /** Event bytes a user's spaces hold (rings, mirrors, `started` copies). */
  userBytes(user: string): number {
    return (
      this.num(
        `SELECT COALESCE(SUM(bytes + mirror_bytes + started_bytes), 0)
         FROM spaces WHERE user_id = ?`,
        user,
      ) ?? 0
    );
  }

  /** The kept mirror of `(model, id)` in `space`. */
  mirror(
    space: string,
    model: string,
    id: string,
  ): { seq: number; bytes: number } | undefined {
    return this.one(
      'SELECT seq, bytes FROM mirrors WHERE space = ? AND model = ? AND id = ?',
      space,
      model,
      id,
    );
  }

  /**
   * What `space`'s ring must drop to take `count` more events (0 or 1)
   * while its ring and mirrors grow by `bytes` (net): the last seq to drop
   * (null: none), the bytes freed, and whether it fits even so.
   */
  ringTrim(
    space: string,
    count: number,
    bytes: number,
  ): { upTo: number | null; freed: number; fits: boolean } {
    const row = this.one<{ n: number; total: number }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS total
       FROM events WHERE space = ?`,
      space,
    );
    const mirrors =
      this.num(
        'SELECT COALESCE(SUM(bytes), 0) FROM mirrors WHERE space = ?',
        space,
      ) ?? 0;
    let n = (row?.n ?? 0) + count;
    let total = (row?.total ?? 0) + mirrors + bytes;
    let upTo: number | null = null;
    let freed = 0;
    while (n > CLOUD_RING || total > MAX_SPACE_EVENT_BYTES) {
      const after: number = upTo ?? -1;
      const batch = this.rows<{ seq: number; bytes: number }>(
        'SELECT seq, bytes FROM events WHERE space = ? AND seq > ? ORDER BY seq LIMIT 32',
        space,
        after,
      );
      if (batch.length === 0) break;
      for (const e of batch) {
        if (n <= CLOUD_RING && total <= MAX_SPACE_EVENT_BYTES) break;
        n -= 1;
        total -= e.bytes;
        freed += e.bytes;
        upTo = e.seq;
      }
    }
    return { upTo, freed, fits: total <= MAX_SPACE_EVENT_BYTES };
  }

  /**
   * Drops the oldest events of the user's finished (stopped, failed) spaces
   * but `except`, oldest space first, then their mirrors the same way, until
   * `want` bytes are freed or none are left. Returns the bytes freed.
   */
  dropFinished(user: string, except: string, want: number): number {
    let freed = 0;
    const touched = new Map<string, number>();
    for (const table of ['events', 'mirrors'] as const) {
      while (freed < want) {
        const batch = this.rows<{ space: string; seq: number; bytes: number }>(
          `SELECT e.space, e.seq, e.bytes FROM ${table} e
           JOIN spaces s ON s.space = e.space
           WHERE s.user_id = ? AND s.space != ? AND s.status IN ('stopped', 'failed')
           ORDER BY s.last_ms, s.space, e.seq LIMIT 64`,
          user,
          except,
        );
        if (batch.length === 0) break;
        for (const e of batch) {
          if (freed >= want) break;
          this.run(
            `DELETE FROM ${table} WHERE space = ? AND seq = ?`,
            e.space,
            e.seq,
          );
          freed += e.bytes;
          touched.set(e.space, Math.max(touched.get(e.space) ?? 0, e.seq));
        }
      }
    }
    for (const [sp, seq] of touched) this.lost(sp, seq);
    return freed;
  }

  /**
   * Stores an event's envelope JSON (`bytes`: its body's) in the ring, after
   * dropping the space's events up to `upTo` (from [`ringTrim`]).
   */
  addEvent(
    space: string,
    seq: number,
    envelope: string,
    bytes: number,
    upTo: number | null,
  ): void {
    this.run(
      `INSERT OR IGNORE INTO events (space, seq, envelope, bytes)
       VALUES (?, ?, ?, ?)`,
      space,
      seq,
      envelope,
      bytes,
    );
    this.trim(space, upTo);
  }

  /**
   * Keeps `envelope` as the latest mirror of `(model, id)` in `space`,
   * replacing the one before it, after dropping the ring up to `upTo`.
   */
  putMirror(
    space: string,
    model: string,
    id: string,
    seq: number,
    envelope: string,
    bytes: number,
    upTo: number | null,
  ): void {
    this.run(
      `INSERT INTO mirrors (space, model, id, seq, envelope, bytes)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (space, model, id) DO UPDATE SET
         seq = excluded.seq, envelope = excluded.envelope, bytes = excluded.bytes
       WHERE excluded.seq > mirrors.seq`,
      space,
      model,
      id,
      seq,
      envelope,
      bytes,
    );
    this.trim(space, upTo);
  }

  /** Drops the ring up to `upTo` (that's lost), then recounts. */
  private trim(space: string, upTo: number | null) {
    if (upTo === null) return this.lost(space, 0);
    this.run('DELETE FROM events WHERE space = ? AND seq <= ?', space, upTo);
    this.lost(space, upTo);
  }

  /**
   * Raises the space's `lost_to` to `seq` and recounts its bytes from the
   * rows themselves, so they never drift.
   */
  lost(space: string, seq: number): void {
    this.run(
      `UPDATE spaces SET
         lost_to = MAX(lost_to, ?),
         bytes = (SELECT COALESCE(SUM(bytes), 0) FROM events WHERE space = ?),
         mirror_bytes =
           (SELECT COALESCE(SUM(bytes), 0) FROM mirrors WHERE space = ?)
       WHERE space = ?`,
      seq,
      space,
      space,
      space,
    );
  }

  /** Forgets spaces: their events, mirrors, subscriptions and rows. */
  dropSpaces(spaces: string[]): void {
    for (const sp of spaces) {
      this.run('DELETE FROM events WHERE space = ?', sp);
      this.run('DELETE FROM mirrors WHERE space = ?', sp);
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
