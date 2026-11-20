/**
 * The MCP device's tables, in the org's `OrgHub` SQLite next to the hub's
 * (src/fleet/store.ts). Every row carries the user it belongs to.
 *
 * ```text
 * mcp_devices   user ─ device id, public key, wrapped private key, the
 *               in-process connection: open, its attachment (ConnState)
 * mcp_pins      (user, device) ─ a computer's key the user confirmed by its
 *               fingerprint (device_trust), the name kept then
 * mcp_inbox     id ─ a frame the hub sent the MCP device (reply, refused,
 *               space_event, space_gap, ask, dismiss), until a tool reads it
 * mcp_requests  req_id ─ a request it sent: target, the key pinned for it,
 *               op, space, the verified outcome once it came
 * mcp_spaces    space ─ a space it started: host, status, name, branch,
 *               last seq, last reply, open question, plan, last refusal
 * mcp_lines     (space, seq, kind) ─ history from verified events, the
 *               newest LINES_KEPT per space
 * meta          mcp_schema ─ MCP_SCHEMA_VERSION; on any other, the tables
 *               but mcp_devices and mcp_pins are dropped
 * ```
 */
import type { ConnState } from '../fleet/hub';
import type { Sql, SqlValue } from '../fleet/store';

export const MCP_SCHEMA_VERSION = 1;

/** History kept per space. */
export const LINES_KEPT = 200;
/** Frames kept per user before the oldest go (a client that never reads). */
export const INBOX_KEPT = 5000;
/** Requests remembered per user (their outcomes). */
export const REQUESTS_KEPT = 500;

const RESET = ['mcp_inbox', 'mcp_requests', 'mcp_spaces', 'mcp_lines'];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS mcp_devices (
    user_id TEXT PRIMARY KEY,
    device_id TEXT,
    public_key TEXT NOT NULL,
    wrapped_key TEXT NOT NULL,
    created_ms INTEGER NOT NULL,
    open INTEGER NOT NULL DEFAULT 0,
    conn_state TEXT)`,
  `CREATE TABLE IF NOT EXISTS mcp_pins (
    user_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    name TEXT NOT NULL,
    pinned_ms INTEGER NOT NULL,
    PRIMARY KEY (user_id, device_id))`,
  `CREATE TABLE IF NOT EXISTS mcp_inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    frame TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS mcp_inbox_user ON mcp_inbox (user_id, id)`,
  `CREATE TABLE IF NOT EXISTS mcp_requests (
    req_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    target_device TEXT NOT NULL,
    target_key TEXT NOT NULL,
    op TEXT NOT NULL,
    space TEXT NOT NULL,
    created_ms INTEGER NOT NULL,
    seq_at INTEGER NOT NULL DEFAULT 0,
    outcome TEXT)`,
  `CREATE INDEX IF NOT EXISTS mcp_requests_user ON mcp_requests (user_id, created_ms)`,
  `CREATE TABLE IF NOT EXISTS mcp_spaces (
    space TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    host_device TEXT NOT NULL,
    host_name TEXT NOT NULL,
    project_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    branch TEXT NOT NULL DEFAULT '',
    last_seq INTEGER NOT NULL DEFAULT 0,
    last_reply TEXT,
    question TEXT,
    plan TEXT,
    build_mode TEXT,
    error TEXT,
    subscribed INTEGER NOT NULL DEFAULT 0,
    created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS mcp_spaces_user ON mcp_spaces (user_id, updated_ms)`,
  `CREATE TABLE IF NOT EXISTS mcp_lines (
    space TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY (space, seq, kind))`,
];

export interface McpDeviceRow {
  user_id: string;
  device_id: string | null;
  public_key: string;
  wrapped_key: string;
  created_ms: number;
  open: number;
  conn_state: string | null;
}

export interface PinRow {
  user_id: string;
  device_id: string;
  public_key: string;
  name: string;
  pinned_ms: number;
}

export interface RequestRow {
  req_id: string;
  user_id: string;
  target_device: string;
  target_key: string;
  op: string;
  space: string;
  created_ms: number;
  /** The space's last seq when it was sent: a later event outdates it. */
  seq_at: number;
  /** JSON `Outcome`, once known. */
  outcome: string | null;
}

/** What came back for a request: only codes for refusals. */
export type Outcome =
  | { kind: 'ok'; value: unknown }
  | { kind: 'err'; code: string }
  | { kind: 'refused'; code: string };

export interface McpSpaceRow {
  space: string;
  user_id: string;
  host_device: string;
  host_name: string;
  project_id: string;
  mode: string;
  /** starting · running · idle · waiting · stopped · failed */
  status: string;
  name: string;
  branch: string;
  last_seq: number;
  last_reply: string | null;
  /** JSON `{ask_id, questions}` of the open question. */
  question: string | null;
  /** The last turn's plan (Plan mode), from the host's mirrored row. */
  plan: string | null;
  build_mode: string | null;
  /** The last refusal's code. */
  error: string | null;
  subscribed: number;
  created_ms: number;
  updated_ms: number;
}

export interface LineRow {
  space: string;
  seq: number;
  kind: string;
  text: string;
}

export class McpStore {
  constructor(readonly sql: Sql) {
    sql.exec(
      'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)',
    );
    const v = this.num("SELECT v FROM meta WHERE k = 'mcp_schema'");
    if (v !== MCP_SCHEMA_VERSION) {
      for (const t of RESET) sql.exec(`DROP TABLE IF EXISTS ${t}`);
    }
    for (const s of SCHEMA) sql.exec(s);
    sql.exec(
      `INSERT INTO meta (k, v) VALUES ('mcp_schema', ?)
       ON CONFLICT (k) DO UPDATE SET v = excluded.v`,
      MCP_SCHEMA_VERSION,
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

  device(user: string): McpDeviceRow | undefined {
    return this.one('SELECT * FROM mcp_devices WHERE user_id = ?', user);
  }

  connState(user: string): ConnState | null {
    const row = this.one<{ conn_state: string | null }>(
      'SELECT conn_state FROM mcp_devices WHERE user_id = ?',
      user,
    );
    return row?.conn_state ? (JSON.parse(row.conn_state) as ConnState) : null;
  }

  pin(user: string, device: string): PinRow | undefined {
    return this.one(
      'SELECT * FROM mcp_pins WHERE user_id = ? AND device_id = ?',
      user,
      device,
    );
  }

  pins(user: string): PinRow[] {
    return this.rows(
      'SELECT * FROM mcp_pins WHERE user_id = ? ORDER BY name',
      user,
    );
  }

  space(user: string, space: string): McpSpaceRow | undefined {
    return this.one(
      'SELECT * FROM mcp_spaces WHERE space = ? AND user_id = ?',
      space,
      user,
    );
  }

  request(user: string, reqId: string): RequestRow | undefined {
    return this.one(
      'SELECT * FROM mcp_requests WHERE req_id = ? AND user_id = ?',
      reqId,
      user,
    );
  }

  /** A frame for the user's MCP device; the oldest go past INBOX_KEPT. */
  addFrame(user: string, frame: string): void {
    this.run(
      'INSERT INTO mcp_inbox (user_id, frame) VALUES (?, ?)',
      user,
      frame,
    );
    this.run(
      `DELETE FROM mcp_inbox WHERE user_id = ? AND id <=
         (SELECT id FROM mcp_inbox WHERE user_id = ?
          ORDER BY id DESC LIMIT 1 OFFSET ?)`,
      user,
      user,
      INBOX_KEPT,
    );
  }

  addLine(space: string, seq: number, kind: string, text: string): void {
    this.run(
      `INSERT OR REPLACE INTO mcp_lines (space, seq, kind, text)
       VALUES (?, ?, ?, ?)`,
      space,
      seq,
      kind,
      text,
    );
    this.run(
      `DELETE FROM mcp_lines WHERE space = ? AND seq <
         (SELECT seq FROM mcp_lines WHERE space = ?
          ORDER BY seq DESC LIMIT 1 OFFSET ?)`,
      space,
      space,
      LINES_KEPT - 1,
    );
  }

  /** Requests past REQUESTS_KEPT per user go, oldest first. */
  trimRequests(user: string): void {
    this.run(
      `DELETE FROM mcp_requests WHERE user_id = ? AND created_ms <
         (SELECT created_ms FROM mcp_requests WHERE user_id = ?
          ORDER BY created_ms DESC LIMIT 1 OFFSET ?)`,
      user,
      user,
      REQUESTS_KEPT - 1,
    );
  }
}
