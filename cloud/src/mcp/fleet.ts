/**
 * The cloud's MCP device (docs/fleet.md "MCP over the cloud"): one per
 * (user, org), living in the org's `OrgHub`. It is a fleet device like a
 * phone, only its key and its "socket" are in the cloud: an in-process
 * connection to the same `Hub`, so every check a device gets (hello
 * signature, routing, the hosts' own trust) applies unchanged.
 *
 * ```text
 * MCP tool call ─▶ online(): device key (made once, kept wrapped)
 *   ─▶ closed? hub.open(internal) ─▶ challenge ─▶ signed hello (kind mcp)
 *      ─▶ welcome ─▶ subscribe again to its spaces (since last seq)
 *   ─▶ hub.extend: online for ONLINE_MS more
 *   ─▶ drain the inbox: replies, refusals, events, questions, each
 *      verified against the pin of the computer that signed it
 *   ─▶ request: signed here (target_key = the pin) ─▶ hub ─▶ the computer
 *      decides (its trust in this device, its caps; Edit/Run wait for a yes)
 *      on a space it started (rs_…), or on any space of that computer by
 *      its local id (protocol 7: list, read, ask, send_to, answer, merge)
 * hub ─▶ InboxConn.send(frame) ─▶ mcp_inbox (until a tool reads it)
 * ```
 *
 * Trust both ways, as a phone: the computer trusts this device after the
 * user compared its fingerprint (`theodore_status`); this device pins a
 * computer only through `device_trust` with the fingerprint the user read
 * on that computer. Requests go only to pinned computers, with the pinned
 * key; replies and events count only if they verify against that pin.
 */
import type {
  DeviceInfo,
  DeviceSummary,
  FleetMode,
  RemoteOp,
  RemoteSpaceEvent,
  ServerMessage,
  SignedEnvelope,
} from '../gen/fleet';
import type { Conn, ConnState, Hub } from '../fleet/hub';
import {
  PROTOCOL_VERSION,
  REQUEST_WINDOW_MS,
  SUB_SPACE_MODEL,
} from '../fleet/limits';
import type { Sql } from '../fleet/store';
import { onAnySpace, unb64, type AnySpaceOp } from '../fleet/wire';
import { subSpaceOf } from './computer';
import {
  fingerprint,
  newDeviceKey,
  normalizeFingerprint,
  open,
  seal,
  signFor,
  unwrapPrivateKey,
  wrapPrivateKey,
} from './crypto';
import {
  McpStore,
  type McpDeviceRow,
  type McpSpaceRow,
  type Outcome,
  type PinRow,
  type RequestRow,
  SUB_SPACES_KEPT,
  type SubSpaceRow,
} from './store';
import {
  gapLine,
  hosts,
  isMode,
  lineOf,
  pinName,
  projectName,
  remoteStatus,
  safeCode,
  truncate,
  uiQuestions,
  validDeviceId,
  validProjectId,
  type QuestionView,
} from './text';

/** Who a tool call acts for: the OAuth grant's user and org. */
export interface McpCaller {
  userId: string;
  orgId: string;
}

export interface McpFleetEnv {
  sql: Sql;
  now(): number;
  /** The org's hub (made after this, hence a function). */
  hub(): Hub;
  /** `MCP_KEY_WRAP`: wraps the device keys at rest. */
  secret: string;
  /** How long a request waits for its reply (default REPLY_WAIT_MS). */
  replyWaitMs?: number;
  /** How long `space_ask` waits for the answer (default MAX_WAIT_MS). */
  askWaitMs?: number;
}

/** How the MCP device lists itself. */
export const MCP_INFO: DeviceInfo = {
  name: 'Claude (MCP)',
  // The hub takes only a real OS in a hello; computers show the kind.
  os: 'linux',
  kind: 'mcp',
  app_version: 'cloud',
  projects: [],
  accepts_remote: false,
  max_mode: 'ask',
  agents: [],
};

/** Online this long after the last tool call, then offline until the next. */
export const ONLINE_MS = 15 * 60_000;
/** How long a start, send, stop or answer waits for the computer's reply. */
export const REPLY_WAIT_MS = 15_000;
/** `space_wait`'s longest wait (MCP clients time out a call near 30 s). */
export const MAX_WAIT_MS = 25_000;
/** What an approval sends, as the desktop and the phone send it. */
export const APPROVED_TEXT = 'Plan approved, implement it.';
/** Longest goal or message accepted. */
export const MAX_TEXT_CHARS = 20_000;

const SETTLED = ['idle', 'waiting', 'stopped', 'failed'];
/** How long a taken start or send may wait for its turn to begin. */
const TURN_START_MS = 2 * 60 * 1000;

/** A tool's refusal: a stable code and static words (no unsigned text). */
export class McpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

/** The MCP device's connection to the hub: its state is a table row. */
class InboxConn implements Conn {
  constructor(
    private fleet: McpFleet,
    readonly user: string,
  ) {}
  get open(): boolean {
    return this.fleet.store.device(this.user)?.open === 1;
  }
  state(): ConnState {
    return this.fleet.store.connState(this.user) as ConnState;
  }
  save(s: ConnState): void {
    this.fleet.store.run(
      'UPDATE mcp_devices SET conn_state = ? WHERE user_id = ?',
      JSON.stringify(s),
      this.user,
    );
  }
  send(text: string): void {
    this.fleet.receive(this.user, text);
  }
  close(): void {
    this.fleet.store.run(
      'UPDATE mcp_devices SET open = 0 WHERE user_id = ?',
      this.user,
    );
  }
}

/** A space as a tool shows it. */
export interface SpaceView {
  space: string;
  computer: { device: string; name: string };
  project: string;
  mode: string;
  status: string;
  name: string;
  branch: string;
  last_reply: string | null;
  question: { ask: string; questions: QuestionView[] } | null;
  plan: string | null;
  /** The mode an approved plan is implemented in. */
  approve_mode: FleetMode | null;
  /** The last refusal, as a code. */
  error: string | null;
  /**
   * "waiting for approval on <computer>": an Edit or Run start or send the
   * computer hasn't answered yet; unless auto mode is on there, a person
   * must Allow it there or on a device it sends its approvals to (≤ 5 min).
   */
  waiting_for: string | null;
  /** Its sub-spaces on the computer (`mirror{sub_space}`), by local id. */
  sub_spaces: SubSpaceView[];
  updated_ms: number;
}

/** A sub-space of a space this device started. */
export interface SubSpaceView {
  /** Its local id on the computer (what the computer's own ops take). */
  space: string;
  /** The space's `rs_` id, or another sub-space's local id. */
  parent: string;
  title: string;
  status: string;
  mode: string;
  done: boolean;
}

/** An op on any space of a computer, by its local id (protocol 7). */
export type ComputerOp = Extract<RemoteOp, { op: AnySpaceOp }>;

/** What came of a computer op, with the computer it went to. */
export interface ComputerSent {
  computer: { device: string; name: string };
  sent: Sent;
}

/** What came of a request a tool sent and waited for. */
export type Sent =
  | { state: 'ok'; value: unknown }
  | { state: 'refused'; by: 'computer' | 'cloud'; code: string }
  | {
      state: 'pending';
      /** "waiting for approval on <computer>" for an Edit or Run. */
      waitingFor: string | null;
      /** Its request id (`space_ask {request}` waits for it again). */
      request: string;
    };

export class McpFleet {
  readonly store: McpStore;
  private challenges = new Map<string, string>();
  private errors = new Map<string, string>();
  private keys = new Map<string, CryptoKey>();
  private wakers = new Set<() => void>();
  private drains = new Map<string, Promise<void>>();
  private gates = new Map<string, Promise<unknown>>();

  constructor(private env: McpFleetEnv) {
    this.store = new McpStore(env.sql);
  }

  /** The open in-process connections, for the hub's `conns`. */
  conns(user?: string): Conn[] {
    const rows =
      user === undefined
        ? this.store.rows<{ user_id: string }>(
            'SELECT user_id FROM mcp_devices WHERE open = 1',
          )
        : this.store.rows<{ user_id: string }>(
            'SELECT user_id FROM mcp_devices WHERE open = 1 AND user_id = ?',
            user,
          );
    return rows.map((r) => new InboxConn(this, r.user_id));
  }

  /** A frame from the hub (inside its message chain: no awaits here). */
  receive(user: string, text: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(text) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'challenge':
        this.challenges.set(user, msg.nonce);
        return;
      case 'welcome':
        this.store.run(
          'UPDATE mcp_devices SET device_id = ? WHERE user_id = ?',
          msg.device_id,
          user,
        );
        return;
      case 'error':
        this.errors.set(user, safeCode(msg.code));
        return;
      case 'reply':
      case 'refused':
      case 'space_event':
      case 'space_gap':
      case 'ask':
      case 'dismiss':
        this.store.addFrame(user, text);
        for (const w of [...this.wakers]) w();
        return;
      default:
        // devices, delegations: read from the hub when needed; it is never
        // a target, so never gets a request or a claim result.
        return;
    }
  }

  // ── the device ─────────────────────────────────────────────────────────

  /** The caller's MCP device, made (and its key wrapped) on first use. */
  async ensureDevice(c: McpCaller): Promise<McpDeviceRow> {
    const row = this.store.device(c.userId);
    if (row) return row;
    const key = await newDeviceKey();
    const wrapped = await wrapPrivateKey(
      this.env.secret,
      { org: c.orgId, user: c.userId, publicKey: key.publicKey },
      key.pkcs8,
    );
    this.store.run(
      `INSERT OR IGNORE INTO mcp_devices
       (user_id, device_id, public_key, wrapped_key, created_ms)
       VALUES (?, NULL, ?, ?, ?)`,
      c.userId,
      key.publicKey,
      wrapped,
      this.env.now(),
    );
    return this.store.device(c.userId)!;
  }

  private async signingKey(c: McpCaller, row: McpDeviceRow) {
    const cached = this.keys.get(`${c.userId}\0${row.public_key}`);
    if (cached) return cached;
    const key = await unwrapPrivateKey(
      this.env.secret,
      { org: c.orgId, user: c.userId, publicKey: row.public_key },
      row.wrapped_key,
    );
    this.keys.set(`${c.userId}\0${row.public_key}`, key);
    return key;
  }

  /**
   * Connected (a signed hello, if it wasn't), online for ONLINE_MS more,
   * and everything the hub sent it read.
   */
  async online(c: McpCaller): Promise<{ me: string; conn: Conn }> {
    // One connect at a time per user: a second hello would spend the
    // first one's challenge.
    const row = await this.serial(c.userId, async () => {
      const row = await this.ensureDevice(c);
      const st = this.store.connState(c.userId);
      if (row.open === 1 && st?.phase === 'ready' && row.device_id) return row;
      await this.connect(c, row);
      return this.store.device(c.userId)!;
    });
    const conn = new InboxConn(this, c.userId);
    await this.env.hub().extend(conn, this.env.now() + ONLINE_MS);
    const me = row.device_id!;
    await this.drain(c, me, conn);
    return { me, conn };
  }

  private serial<T>(user: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.gates.get(user) ?? Promise.resolve();
    const next = prev.then(fn);
    this.gates.set(
      user,
      next.catch(() => {}),
    );
    return next;
  }

  private async connect(c: McpCaller, row: McpDeviceRow) {
    const hub = this.env.hub();
    this.store.run(
      'UPDATE mcp_devices SET open = 1, conn_state = NULL WHERE user_id = ?',
      c.userId,
    );
    const conn = new InboxConn(this, c.userId);
    this.challenges.delete(c.userId);
    this.errors.delete(c.userId);
    await hub.open(
      conn,
      { userId: c.userId, orgId: c.orgId, expMs: this.env.now() + ONLINE_MS },
      true,
    );
    const nonce = unb64(this.challenges.get(c.userId) ?? '');
    this.challenges.delete(c.userId);
    if (!nonce || !conn.open) throw this.notConnected(c);
    const key = await this.signingKey(c, row);
    await hub.message(
      conn,
      JSON.stringify({
        type: 'hello',
        protocol: PROTOCOL_VERSION,
        device_id: row.device_id,
        public_key: row.public_key,
        signature: await signFor(key, 'hello', nonce),
        info: MCP_INFO,
        spaces: [],
      }),
    );
    if (!conn.open || this.store.connState(c.userId)?.phase !== 'ready') {
      throw this.notConnected(c);
    }
    // What happened while it was away comes as history.
    for (const sp of this.store.rows<McpSpaceRow>(
      'SELECT * FROM mcp_spaces WHERE user_id = ? AND subscribed = 1',
      c.userId,
    )) {
      await this.subscribe(conn, sp);
    }
  }

  private notConnected(c: McpCaller) {
    const code = this.errors.get(c.userId) ?? 'fleet.unavailable';
    return new McpError(code, 'the fleet refused the MCP device’s connection');
  }

  private subscribe(conn: Conn, sp: McpSpaceRow) {
    return this.env.hub().message(
      conn,
      JSON.stringify({
        type: 'subscribe',
        space: sp.space,
        since: sp.last_seq,
      }),
    );
  }

  // ── the inbox ──────────────────────────────────────────────────────────

  /** Reads every frame waiting for the caller's device, one drain at a time. */
  private drain(c: McpCaller, me: string, conn: Conn): Promise<void> {
    const prev = this.drains.get(c.userId) ?? Promise.resolve();
    const next = prev.then(async () => {
      for (;;) {
        const rows = this.store.rows<{ id: number; frame: string }>(
          'SELECT id, frame FROM mcp_inbox WHERE user_id = ? ORDER BY id LIMIT 200',
          c.userId,
        );
        // Reading a frame can bring more (a subscription's history).
        if (rows.length === 0) return;
        for (const r of rows) {
          try {
            await this.apply(c.userId, me, conn, JSON.parse(r.frame));
          } catch (e) {
            console.error('mcp.frame', e instanceof Error ? e.name : typeof e);
          }
          this.store.run('DELETE FROM mcp_inbox WHERE id = ?', r.id);
        }
      }
    });
    const settled = next.catch(() => {});
    this.drains.set(c.userId, settled);
    return next;
  }

  private async apply(
    user: string,
    me: string,
    conn: Conn,
    msg: ServerMessage,
  ): Promise<void> {
    switch (msg.type) {
      case 'reply':
        return this.onReply(user, me, conn, msg.envelope);
      case 'refused': {
        const req = this.store.request(user, msg.req_id);
        if (!req || req.outcome) return;
        return this.settle(user, conn, req, {
          kind: 'refused',
          code: safeCode(msg.code),
        });
      }
      case 'space_event':
        return this.onEvent(user, msg.envelope);
      case 'space_gap': {
        const sp = this.store.space(user, msg.space);
        if (!sp || typeof msg.from !== 'number' || typeof msg.to !== 'number') {
          return;
        }
        const line = gapLine(msg.from, msg.to);
        this.store.addLine(sp.space, line.seq, line.kind, line.text);
        return;
      }
      case 'ask':
        return this.onAsk(user, msg.envelope);
      case 'dismiss':
        // `moved`: still open, shown elsewhere.
        if (msg.reason === 'moved') return;
        for (const sp of this.store.rows<McpSpaceRow>(
          'SELECT * FROM mcp_spaces WHERE user_id = ? AND question IS NOT NULL',
          user,
        )) {
          if (questionOf(sp)?.ask === msg.ask_id) {
            this.update(sp.space, { question: null });
          }
        }
        return;
      default:
        return;
    }
  }

  private async onReply(
    user: string,
    me: string,
    conn: Conn,
    envelope: SignedEnvelope,
  ) {
    const reqId = peekField(envelope, 'req_id');
    if (typeof reqId !== 'string') return;
    const req = this.store.request(user, reqId);
    if (!req || req.outcome || envelope.device_id !== req.target_device) return;
    // Against the key pinned when it was sent.
    const body = await open(envelope, req.target_key, 'reply');
    if (
      !body ||
      body.req_id !== reqId ||
      body.origin_device !== me ||
      body.target_device !== req.target_device
    ) {
      return;
    }
    const o = body.outcome as Record<string, unknown> | undefined;
    if (o?.outcome === 'ok') {
      return this.settle(user, conn, req, { kind: 'ok', value: o.value });
    }
    if (o?.outcome === 'err') {
      // An agent gets the code only, never the computer's words.
      return this.settle(user, conn, req, {
        kind: 'err',
        code: safeCode(o.code),
      });
    }
  }

  private async settle(
    user: string,
    conn: Conn,
    req: RequestRow,
    outcome: Outcome,
  ) {
    this.store.run(
      'UPDATE mcp_requests SET outcome = ? WHERE req_id = ?',
      JSON.stringify(outcome),
      req.req_id,
    );
    // An op on any space of a computer leaves the spaces here as they are:
    // its outcome is for the tool that waits for it.
    if (onAnySpace(req.op)) return;
    const sp = this.store.space(user, req.space);
    if (!sp) return;
    if (req.op === 'start_space') {
      if (outcome.kind === 'ok') {
        const v = (
          outcome.value && typeof outcome.value === 'object'
            ? outcome.value
            : {}
        ) as Record<string, unknown>;
        this.update(sp.space, {
          name: typeof v.name === 'string' ? truncate(v.name, 200) : sp.name,
          branch:
            typeof v.branch === 'string' ? truncate(v.branch, 200) : sp.branch,
          status: sp.status === 'starting' ? 'running' : sp.status,
          error: null,
          subscribed: 1,
        });
        // Before the host's signed ok the cloud doesn't know the space.
        await this.subscribe(conn, { ...sp, subscribed: 1 });
      } else {
        this.update(sp.space, { status: 'failed', error: outcome.code });
      }
      return;
    }
    if (outcome.kind !== 'ok') {
      this.update(sp.space, { error: outcome.code });
      return;
    }
    // A send it took is a turn about to run, unless an event came since.
    const running = req.op === 'send' && sp.last_seq === req.seq_at;
    this.update(sp.space, {
      error: null,
      ...(running ? { status: 'running' } : {}),
    });
  }

  private async onEvent(user: string, envelope: SignedEnvelope) {
    const space = peekField(envelope, 'space');
    if (typeof space !== 'string') return;
    const sp = this.store.space(user, space);
    if (!sp || envelope.device_id !== sp.host_device) return;
    const pin = this.store.pin(user, sp.host_device);
    if (!pin) return;
    const body = await open(envelope, pin.public_key, 'event');
    if (
      !body ||
      body.space !== space ||
      body.host_device !== sp.host_device ||
      typeof body.seq !== 'number'
    ) {
      return;
    }
    this.applyEvent(this.store.space(user, space)!, body.seq, body.event);
  }

  private applyEvent(sp: McpSpaceRow, seq: number, ev: RemoteSpaceEvent) {
    if (seq <= sp.last_seq || !ev || typeof ev !== 'object') return;
    if (ev.kind === 'mirror') {
      // The space row (its plan and build mode) and its sub-spaces. Holes
      // in seq from compaction aren't gaps.
      if (ev.model === SUB_SPACE_MODEL) this.onSubSpace(sp, seq, ev);
      const patch: Partial<McpSpaceRow> = { last_seq: seq };
      if (ev.model === 'space' && ev.data && typeof ev.data === 'object') {
        const row = ev.data as Record<string, unknown>;
        const log = Array.isArray(row.turn_log) ? row.turn_log : [];
        const last = log
          .filter(
            (t): t is Record<string, unknown> =>
              !!t && typeof t === 'object' && !t.undone,
          )
          .at(-1);
        patch.plan =
          typeof last?.plan === 'string' && last.plan.trim()
            ? truncate(last.plan, 8000)
            : null;
        patch.build_mode = row.build_mode === 'run' ? 'run' : 'edit';
        // The host names a space after its first turn: follow its title.
        const title =
          typeof row.title === 'string' && row.title.trim()
            ? row.title
            : typeof row.name === 'string'
              ? row.name
              : '';
        if (title.trim()) patch.name = truncate(title.trim(), 200);
      }
      this.update(sp.space, patch);
      return;
    }
    const line = lineOf(seq, ev);
    if (!line) return;
    const e = ev as Record<string, unknown>;
    const patch: Partial<McpSpaceRow> = { last_seq: seq };
    switch (ev.kind) {
      case 'started':
        patch.name = typeof e.name === 'string' ? truncate(e.name, 200) : '';
        patch.branch =
          typeof e.branch === 'string' ? truncate(e.branch, 200) : '';
        if (isMode(e.mode)) patch.mode = e.mode;
        if (sp.status === 'starting') patch.status = 'running';
        break;
      case 'status': {
        const s = remoteStatus(e.status);
        if (s) patch.status = s;
        break;
      }
      case 'reply':
        patch.last_reply =
          typeof e.text === 'string' ? truncate(e.text, 8000) : '';
        break;
      case 'question':
        if (typeof e.ask_id === 'string') {
          patch.question = JSON.stringify({
            ask: e.ask_id,
            questions: uiQuestions(e.questions),
          });
        }
        break;
      case 'question_cleared':
        if (questionOf(sp)?.ask === e.ask_id) patch.question = null;
        break;
      default:
        break;
    }
    this.store.addLine(sp.space, line.seq, line.kind, line.text);
    this.update(sp.space, patch);
  }

  /**
   * A sub-space under `sp`, kept as the latest per id (`null` data: gone),
   * with a line when its title, status or done changes.
   */
  private onSubSpace(
    sp: McpSpaceRow,
    seq: number,
    ev: Extract<RemoteSpaceEvent, { kind: 'mirror' }>,
  ) {
    const old = this.store.one<SubSpaceRow>(
      'SELECT * FROM mcp_sub_spaces WHERE space = ? AND id = ?',
      sp.space,
      ev.id,
    );
    if (ev.data === null || ev.data === undefined) {
      if (!old) return;
      this.store.run(
        'DELETE FROM mcp_sub_spaces WHERE space = ? AND id = ?',
        sp.space,
        ev.id,
      );
      this.store.addLine(
        sp.space,
        seq,
        'sub_space',
        `${old.id} · ${old.title} · removed`,
      );
      return;
    }
    const sub = subSpaceOf(ev.id, ev.data);
    if (!sub) return;
    if (
      !old &&
      (this.store.num(
        'SELECT COUNT(*) AS n FROM mcp_sub_spaces WHERE space = ?',
        sp.space,
      ) ?? 0) >= SUB_SPACES_KEPT
    ) {
      return;
    }
    this.store.run(
      `INSERT INTO mcp_sub_spaces
         (space, id, parent, title, status, mode, done, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (space, id) DO UPDATE SET parent = excluded.parent,
         title = excluded.title, status = excluded.status,
         mode = excluded.mode, done = excluded.done, seq = excluded.seq`,
      sp.space,
      sub.space,
      sub.parent,
      sub.title,
      sub.status,
      sub.mode,
      sub.done ? 1 : 0,
      seq,
    );
    if (
      !old ||
      old.title !== sub.title ||
      old.status !== sub.status ||
      old.done !== (sub.done ? 1 : 0)
    ) {
      this.store.addLine(
        sp.space,
        seq,
        'sub_space',
        `${sub.space} · ${sub.title} · ${sub.status}${sub.done ? ' · done' : ''}`,
      );
    }
  }

  private async onAsk(user: string, envelope: SignedEnvelope) {
    if (typeof envelope?.device_id !== 'string') return;
    const pin = this.store.pin(user, envelope.device_id);
    if (!pin) return;
    const ask = await open(envelope, pin.public_key, 'ask');
    if (!ask || typeof ask.ask_id !== 'string') return;
    const sp = this.store.space(user, ask.space);
    if (!sp || sp.host_device !== ask.host_device) return;
    this.update(sp.space, {
      question: JSON.stringify({
        ask: ask.ask_id,
        questions: uiQuestions(ask.questions),
      }),
    });
  }

  private update(space: string, patch: Partial<McpSpaceRow>) {
    const keys = Object.keys(patch) as (keyof McpSpaceRow)[];
    const sets = [...keys.map((k) => `${k} = ?`), 'updated_ms = ?'];
    this.store.run(
      `UPDATE mcp_spaces SET ${sets.join(', ')} WHERE space = ?`,
      ...keys.map((k) => patch[k] as string | number | null),
      this.env.now(),
      space,
    );
  }

  // ── what the tools do ──────────────────────────────────────────────────

  /** The user's devices as the cloud lists them (protocol 5: every kind). */
  private listed(user: string): DeviceSummary[] {
    return this.env.hub().listDevices(user);
  }

  /** `device` as an id: an id passes; a name (case aside) must be exactly
   *  one computer's, as listed or as pinned here. Anything else passes as
   *  is and fails as an unknown device. */
  private resolve(user: string, device: string): string {
    const isId: boolean = validDeviceId(device);
    if (isId) return device;
    const want = device.toLowerCase();
    const ids = new Set(
      this.listed(user)
        .filter((d) => hosts(d.info.kind))
        .filter(
          (d) =>
            pinName(d.info.name).toLowerCase() === want ||
            this.store.pin(user, d.device_id)?.name.toLowerCase() === want,
        )
        .map((d) => d.device_id),
    );
    if (ids.size > 1) {
      throw new McpError(
        'mcp.invalid',
        'more than one computer has that name: pass its device id from devices_list',
      );
    }
    return [...ids][0] ?? device;
  }

  async status(c: McpCaller) {
    const { me } = await this.online(c);
    const row = this.store.device(c.userId)!;
    const computers = this.listed(c.userId).filter((d) => hosts(d.info.kind));
    return {
      device: {
        id: me,
        name: MCP_INFO.name,
        fingerprint: await fingerprint(row.public_key),
      },
      organization: c.orgId,
      computers: computers.map((d) => ({
        device: d.device_id,
        name: pinName(d.info.name),
        online: d.online,
        trusted_here: this.trustOf(c.userId, d),
      })),
    };
  }

  private trustOf(
    user: string,
    d: DeviceSummary,
  ): 'yes' | 'no' | 'key_changed' {
    const pin = this.store.pin(user, d.device_id);
    if (!pin) return 'no';
    return pin.public_key === d.public_key ? 'yes' : 'key_changed';
  }

  async devices(c: McpCaller) {
    await this.online(c);
    return this.listed(c.userId)
      .filter((d) => hosts(d.info.kind))
      .map((d) => ({
        device: d.device_id,
        name: pinName(d.info.name),
        kind: d.info.kind,
        os: d.info.os,
        online: d.online,
        last_seen_ms: d.last_seen_ms,
        trusted_here: this.trustOf(c.userId, d),
        accepts_remote: d.info.accepts_remote,
        max_mode: d.info.max_mode,
      }));
  }

  /** Pins `device` if `typed` is its fingerprint (as shown on it). */
  async trust(c: McpCaller, named: string, typed: string) {
    await this.online(c);
    const device = this.resolve(c.userId, named);
    const d = this.listed(c.userId).find((x) => x.device_id === device);
    if (!d) throw new McpError('mcp.unknown_device', 'no such computer');
    if (!hosts(d.info.kind)) {
      throw new McpError(
        'mcp.invalid',
        'only a computer (the desktop app or a daemon) runs spaces',
      );
    }
    const want = normalizeFingerprint(await fingerprint(d.public_key));
    if (normalizeFingerprint(typed) !== want) {
      throw new McpError(
        'mcp.fingerprint_mismatch',
        'that is not this computer’s fingerprint: ask the user to read it on the computer, in Theodore → Devices',
      );
    }
    const name = pinName(d.info.name);
    this.store.run(
      `INSERT INTO mcp_pins (user_id, device_id, public_key, name, pinned_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, device_id) DO UPDATE SET
         public_key = excluded.public_key, name = excluded.name,
         pinned_ms = excluded.pinned_ms`,
      c.userId,
      device,
      d.public_key,
      name,
      this.env.now(),
    );
    return { device, name, trusted_here: 'yes' as const };
  }

  async projects(c: McpCaller, named: string) {
    await this.online(c);
    const device = this.resolve(c.userId, named);
    const d = this.listed(c.userId).find((x) => x.device_id === device);
    if (!d || !hosts(d.info.kind)) {
      throw new McpError('mcp.unknown_device', 'no such computer');
    }
    return {
      device,
      name: pinName(d.info.name),
      online: d.online,
      trusted_here: this.trustOf(c.userId, d),
      accepts_remote: d.info.accepts_remote,
      max_mode: d.info.max_mode,
      // Ids only where they pass the agents' pattern; names cut like pins.
      projects: d.info.projects
        .filter((p) => validProjectId(p.id))
        .map((p) => ({ id: p.id, name: projectName(p.name) })),
      agents: (d.info.agents ?? []).map((a) => ({
        id: a.id,
        default_model: a.default_model ?? null,
        default_effort: a.default_effort ?? null,
        models: (a.models ?? []).map((m) => ({
          id: m.id,
          efforts: m.efforts ?? [],
        })),
      })),
    };
  }

  async spaces(c: McpCaller): Promise<SpaceView[]> {
    await this.online(c);
    return this.store
      .rows<McpSpaceRow>(
        'SELECT * FROM mcp_spaces WHERE user_id = ? ORDER BY updated_ms DESC',
        c.userId,
      )
      .map((sp) => this.view(c.userId, sp));
  }

  /** A pinned computer whose listed key is still the pinned one. */
  private target(user: string, named: string): PinRow {
    const device = this.resolve(user, named);
    const pin = this.store.pin(user, device);
    if (!pin) {
      throw new McpError(
        'mcp.untrusted_device',
        'this computer is not trusted here yet: use device_trust with the fingerprint the user reads on it',
      );
    }
    const d = this.listed(user).find((x) => x.device_id === device);
    if (!d) throw new McpError('mcp.unknown_device', 'no such computer');
    if (d.public_key !== pin.public_key) {
      throw new McpError(
        'mcp.key_changed',
        'this computer’s key changed since it was trusted: compare its fingerprint again (device_trust)',
      );
    }
    if (!hosts(d.info.kind)) {
      throw new McpError('mcp.invalid', 'that device runs no spaces');
    }
    return pin;
  }

  private ownSpace(user: string, space: string): McpSpaceRow {
    const sp = typeof space === 'string' && this.store.space(user, space);
    if (!sp) {
      throw new McpError(
        'mcp.unknown_space',
        'not a space started through this MCP connection',
      );
    }
    return sp;
  }

  async start(
    c: McpCaller,
    a: {
      device: string;
      project: string;
      goal: string;
      mode: FleetMode;
      agent?: string | null;
      model?: string | null;
      effort?: string | null;
    },
  ): Promise<{ space: SpaceView; sent: Sent }> {
    if (!validProjectId(a.project)) {
      throw new McpError('mcp.invalid', 'project must be a project id');
    }
    const { me, conn } = await this.online(c);
    const pin = this.target(c.userId, a.device);
    const space = `rs_${crypto.randomUUID().replace(/-/g, '')}`;
    const now = this.env.now();
    this.store.run(
      `INSERT INTO mcp_spaces (space, user_id, host_device, host_name,
         project_id, mode, status, created_ms, updated_ms)
       VALUES (?, ?, ?, ?, ?, ?, 'starting', ?, ?)`,
      space,
      c.userId,
      pin.device_id,
      pin.name,
      a.project,
      a.mode,
      now,
      now,
    );
    this.trimSpaces(c.userId);
    const sent = await this.send(c, me, conn, pin, {
      op: 'start_space',
      space,
      project_id: a.project,
      goal: a.goal,
      mode: a.mode,
      agent: a.agent ?? null,
      model: a.model ?? null,
      effort: a.effort ?? null,
      parent: null,
      depth: 0,
    });
    return {
      space: this.view(c.userId, this.store.space(c.userId, space)!),
      sent,
    };
  }

  /** Spaces past the cloud's 200 per user: the oldest finished go here too. */
  private trimSpaces(user: string) {
    const old = this.store.rows<{ space: string }>(
      `SELECT space FROM mcp_spaces WHERE user_id = ?
         AND status IN ('stopped', 'failed')
       ORDER BY updated_ms DESC LIMIT -1 OFFSET 100`,
      user,
    );
    for (const o of old) {
      this.store.run('DELETE FROM mcp_lines WHERE space = ?', o.space);
      this.store.run('DELETE FROM mcp_sub_spaces WHERE space = ?', o.space);
      this.store.run('DELETE FROM mcp_spaces WHERE space = ?', o.space);
    }
  }

  async message(
    c: McpCaller,
    space: string,
    text: string,
    mode: FleetMode | null,
  ): Promise<Sent> {
    const sp = this.ownSpace(c.userId, space);
    const { me, conn } = await this.online(c);
    const pin = this.target(c.userId, sp.host_device);
    return this.send(c, me, conn, pin, {
      op: 'send',
      space: sp.space,
      text,
      mode,
      agent: null,
      model: null,
      effort: null,
    });
  }

  async stop(c: McpCaller, space: string): Promise<Sent> {
    const sp = this.ownSpace(c.userId, space);
    const { me, conn } = await this.online(c);
    const pin = this.target(c.userId, sp.host_device);
    return this.send(c, me, conn, pin, { op: 'stop', space: sp.space });
  }

  async answer(
    c: McpCaller,
    space: string,
    ask: string,
    answers: string[][],
  ): Promise<Sent> {
    const sp = this.ownSpace(c.userId, space);
    const { me, conn } = await this.online(c);
    const pin = this.target(c.userId, sp.host_device);
    const q = questionOf(this.store.space(c.userId, sp.space)!);
    if (q && q.ask === ask && q.questions.length !== answers.length) {
      throw new McpError(
        'mcp.invalid',
        `answer each of the ${q.questions.length} questions, in order`,
      );
    }
    const sent = await this.send(c, me, conn, pin, {
      op: 'answer',
      space: sp.space,
      ask_id: ask,
      answers,
    });
    if (sent.state === 'ok' && q?.ask === ask) {
      this.update(sp.space, { question: null });
    }
    return sent;
  }

  async approve(c: McpCaller, space: string): Promise<Sent> {
    this.ownSpace(c.userId, space);
    const { me, conn } = await this.online(c);
    const sp = this.store.space(c.userId, space)!;
    if (sp.status === 'running' || sp.status === 'starting') {
      throw new McpError(
        'mcp.busy',
        'the agent is still working in this space: wait for it first',
      );
    }
    if (!sp.plan) {
      throw new McpError('mcp.no_plan', 'the last turn has no plan to approve');
    }
    const pin = this.target(c.userId, sp.host_device);
    return this.send(c, me, conn, pin, {
      op: 'send',
      space: sp.space,
      text: APPROVED_TEXT,
      mode: sp.build_mode === 'run' ? 'run' : 'edit',
      agent: null,
      model: null,
      effort: null,
    });
  }

  // ── any space of a computer (protocol 7) ───────────────────────────────

  /** Whether `space` is one this device started (and still knows). */
  startedHere(c: McpCaller, space: string): boolean {
    return this.store.space(c.userId, space) !== undefined;
  }

  /**
   * `op` on any space of a pinned computer, signed and sent; waits up to
   * `ms` for the reply. The computer resolves the id (its own, or an `rs_`
   * one it hosts for this device) and decides, as for any request.
   */
  async onComputer(
    c: McpCaller,
    device: string,
    op: ComputerOp,
    ms?: number,
  ): Promise<ComputerSent> {
    const { me, conn } = await this.online(c);
    const pin = this.target(c.userId, device);
    return {
      computer: { device: pin.device_id, name: pin.name },
      sent: await this.send(c, me, conn, pin, op, ms),
    };
  }

  /** `ask_space`: slow (the computer gives it minutes), so a longer wait. */
  ask(c: McpCaller, device: string, space: string, question: string) {
    return this.onComputer(
      c,
      device,
      { op: 'ask_space', space, question },
      this.env.askWaitMs ?? MAX_WAIT_MS,
    );
  }

  /** Waits again for an `ask_space` this device sent (`space_ask {request}`). */
  async askAgain(c: McpCaller, request: string): Promise<ComputerSent> {
    const req =
      typeof request === 'string'
        ? this.store.request(c.userId, request)
        : undefined;
    if (!req || req.op !== 'ask_space') {
      throw new McpError(
        'mcp.unknown_request',
        'not a space_ask request made through this MCP connection',
      );
    }
    const { me, conn } = await this.online(c);
    const name =
      this.store.pin(c.userId, req.target_device)?.name ??
      pinName(
        this.listed(c.userId).find((d) => d.device_id === req.target_device)
          ?.info.name ?? '',
      );
    return {
      computer: { device: req.target_device, name },
      sent: await this.outcome(
        c,
        me,
        conn,
        req.req_id,
        this.env.askWaitMs ?? MAX_WAIT_MS,
        () => null,
      ),
    };
  }

  async read(c: McpCaller, space: string, since: number) {
    this.ownSpace(c.userId, space);
    await this.online(c);
    const sp = this.store.space(c.userId, space)!;
    const lines = this.store
      .rows<{ seq: number; kind: string; text: string }>(
        `SELECT seq, kind, text FROM mcp_lines WHERE space = ? AND seq > ?
         ORDER BY seq DESC LIMIT 50`,
        sp.space,
        since,
      )
      .reverse();
    return { ...this.view(c.userId, sp), last_seq: sp.last_seq, lines };
  }

  /** Until every space is idle, waiting, stopped or failed, or `ms` pass. */
  async wait(c: McpCaller, spaces: string[], ms: number) {
    for (const s of spaces) this.ownSpace(c.userId, s);
    const { me, conn } = await this.online(c);
    const views = () =>
      spaces.map((s) => this.view(c.userId, this.store.space(c.userId, s)!));
    // Waiting for a person (a question, an approval) is for the user now.
    const settled = (v: SpaceView) =>
      SETTLED.includes(v.status) ||
      v.question !== null ||
      v.waiting_for !== null;
    const done = await this.until(c, me, conn, ms, () => {
      const v = views();
      return v.every(settled) ? v : null;
    });
    const out = done ?? views();
    return {
      settled: out.every(settled),
      spaces: out.map((v) => ({
        space: v.space,
        status: v.status,
        question: v.question !== null,
        plan: v.plan !== null,
        waiting_for: v.waiting_for,
        error: v.error,
      })),
    };
  }

  /**
   * Signs `op` for `pin`, sends it and waits for its outcome. Space ops
   * only: `confirm` and `set_mcp_auto` are a person's, never Claude's.
   */
  private async send(
    c: McpCaller,
    me: string,
    conn: Conn,
    pin: PinRow,
    op: Exclude<RemoteOp, { op: 'confirm' | 'set_mcp_auto' }>,
    waitMs = this.env.replyWaitMs ?? REPLY_WAIT_MS,
  ): Promise<Sent> {
    // A space it started, or the computer's own space the op names (its
    // parent, for a merge; none for a list).
    const space =
      op.op === 'merge_child'
        ? op.parent
        : op.op === 'list_spaces'
          ? ''
          : op.space;
    const row = this.store.device(c.userId)!;
    const key = await this.signingKey(c, row);
    const reqId = `req_${crypto.randomUUID()}`;
    const now = this.env.now();
    const envelope = await seal(
      {
        req_id: reqId,
        origin_device: me,
        target_device: pin.device_id,
        target_key: pin.public_key,
        issued_at_ms: now,
        op,
      },
      key,
    );
    this.store.run(
      `INSERT INTO mcp_requests (req_id, user_id, target_device, target_key,
         op, space, mode, created_ms, seq_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      reqId,
      c.userId,
      pin.device_id,
      pin.public_key,
      op.op,
      space,
      op.op === 'start_space' || op.op === 'send' ? (op.mode ?? null) : null,
      now,
      this.store.space(c.userId, space)?.last_seq ?? 0,
    );
    this.store.trimRequests(c.userId);
    await this.env
      .hub()
      .message(conn, JSON.stringify({ type: 'request', envelope }));
    return this.outcome(c, me, conn, reqId, waitMs, () =>
      this.waitingFor(c.userId, space),
    );
  }

  /** Waits up to `ms` for request `reqId`'s outcome. */
  private async outcome(
    c: McpCaller,
    me: string,
    conn: Conn,
    reqId: string,
    ms: number,
    waitingFor: () => string | null,
  ): Promise<Sent> {
    const outcome = await this.until(c, me, conn, ms, () => {
      const r = this.store.request(c.userId, reqId);
      return r?.outcome ? (JSON.parse(r.outcome) as Outcome) : null;
    });
    if (!outcome) {
      return { state: 'pending', waitingFor: waitingFor(), request: reqId };
    }
    if (outcome.kind === 'ok') return { state: 'ok', value: outcome.value };
    return {
      state: 'refused',
      by: outcome.kind === 'err' ? 'computer' : 'cloud',
      code: outcome.code,
    };
  }

  /** A space as a tool shows it, with what it waits for. */
  private view(user: string, sp: McpSpaceRow): SpaceView {
    // A host reports `idle` right after making a space, before the goal's
    // turn starts (and between a send's ok and its turn): while a turn it
    // took hasn't ended, the space is still running.
    const owed = sp.status === 'idle' && this.turnsOwed(user, sp.space);
    return viewOf(
      owed ? { ...sp, status: 'running' } : sp,
      this.waitingFor(user, sp.space),
      this.store.subSpaces(sp.space),
    );
  }

  /**
   * Whether the last start or send the host took hasn't begun its turn yet
   * (nothing of a turn since: no turn, tool, reply, question or end line),
   * for up to `TURN_START_MS`: a turn starts within
   * seconds, and a missed event must not keep a space running for good.
   */
  private turnsOwed(user: string, space: string): boolean {
    const req = this.store.one<RequestRow>(
      `SELECT * FROM mcp_requests
       WHERE user_id = ? AND space = ? AND op IN ('start_space', 'send')
         AND json_extract(outcome, '$.kind') = 'ok'
       ORDER BY created_ms DESC LIMIT 1`,
      user,
      space,
    );
    if (!req || this.env.now() - req.created_ms > TURN_START_MS) return false;
    const began = this.store.one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM mcp_lines
       WHERE space = ? AND kind IN ('turn', 'tool', 'reply', 'question', 'ended')
         AND seq > ?`,
      space,
      req.seq_at,
    );
    return (began?.n ?? 0) === 0;
  }

  /**
   * "waiting for approval on <computer>" while an Edit or Run start or send
   * (a plan's approval too) has no answer and is inside the request window:
   * the computer is asking a person (unless its auto mode covers it). A
   * send without a mode runs in the space's, so an Edit or Run space's send
   * counts too.
   */
  private waitingFor(user: string, space: string): string | null {
    const sp = this.store.space(user, space);
    if (!sp) return null;
    const open = this.store.one<RequestRow>(
      `SELECT * FROM mcp_requests
       WHERE user_id = ? AND space = ? AND outcome IS NULL
         AND op IN ('start_space', 'send') AND created_ms > ?
       ORDER BY created_ms DESC LIMIT 1`,
      user,
      space,
      this.env.now() - REQUEST_WINDOW_MS,
    );
    if (!open) return null;
    const mode = open.mode ?? sp.mode;
    return mode === 'edit' || mode === 'run'
      ? `waiting for approval on ${sp.host_name}`
      : null;
  }

  /** Drains until `check` gives something, or `ms` pass (then `null`). */
  private async until<T>(
    c: McpCaller,
    me: string,
    conn: Conn,
    ms: number,
    check: () => T | null,
  ): Promise<T | null> {
    const end = Date.now() + ms;
    for (;;) {
      await this.drain(c, me, conn);
      const got = check();
      if (got !== null) return got;
      const left = end - Date.now();
      if (left <= 0) return null;
      await this.nudge(Math.min(left, 1000));
    }
  }

  /** Resolves when a frame arrives, or after `ms`. */
  private nudge(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wakers.add(done);
    });
  }
}

function peekField(envelope: SignedEnvelope, k: string): unknown {
  try {
    const v = JSON.parse(envelope?.body) as Record<string, unknown> | null;
    return v && typeof v === 'object' ? v[k] : undefined;
  } catch {
    return undefined;
  }
}

function questionOf(
  sp: McpSpaceRow,
): { ask: string; questions: QuestionView[] } | null {
  if (!sp.question) return null;
  try {
    return JSON.parse(sp.question) as {
      ask: string;
      questions: QuestionView[];
    };
  } catch {
    return null;
  }
}

export function viewOf(
  sp: McpSpaceRow,
  waitingFor: string | null = null,
  subSpaces: SubSpaceRow[] = [],
): SpaceView {
  return {
    space: sp.space,
    computer: { device: sp.host_device, name: sp.host_name },
    project: sp.project_id,
    mode: sp.mode,
    status: sp.status,
    name: sp.name,
    branch: sp.branch,
    last_reply: sp.last_reply,
    question: questionOf(sp),
    plan: sp.plan,
    approve_mode: sp.plan ? (sp.build_mode === 'run' ? 'run' : 'edit') : null,
    error: sp.error,
    waiting_for: waitingFor,
    sub_spaces: subSpaces.map((s) => ({
      space: s.id,
      parent: s.parent,
      title: s.title,
      status: s.status,
      mode: s.mode,
      done: s.done === 1,
    })),
    updated_ms: sp.updated_ms,
  };
}
