/**
 * The fleet hub of one org (docs/fleet.md): plain TS over small interfaces
 * (SQL, sockets, clock, token check) so it runs in tests without the
 * Workers runtime; `org-hub.ts` is the Durable Object around it.
 *
 * ```text
 * open (≤ 10 per user) ─▶ one challenge ─▶ hello (ed25519 over
 *   "theodore-fleet-hello-v3\0" ‖ 32-byte nonce) ─▶ welcome, devices
 *   ─▶ request ─▶ target: request{generation} ─▶ claim ─▶ claim_result
 *              ─▶ reply (target-signed) ─▶ origin
 *              └─ refused{code} ─▶ origin   (offline: 10 s grace, 2 min ttl)
 *   ─▶ space_event (host-signed) ─▶ ring 500 + latest mirror per row, 16 MiB
 *      (turn_step mirrors: relayed only) ─▶ subscribers (mirrors: protocol 4)
 *   ─▶ ask (host-signed) ─▶ active if a follower/host │ followers; 20 s ─▶ followers
 *                          └─ push (Expo) to followers away from a screen
 *   ─▶ delegate (origin-signed) ─▶ delegations{list} ─▶ origin, delegate
 *   ─▶ confirm (host-signed, protocol 6) ─▶ the host's live delegates on 6,
 *        again after their welcome │ push (Expo) to those away from a screen
 *      confirm_resolved (its host) │ expiry │ delegation ended
 *        ─▶ confirm_dismissed ─▶ where it showed
 *      a delegate's yes/no: request{op: confirm} ─▶ host (routed as below)
 *   ─▶ request on any space of the target (protocol 7: list_spaces …
 *      merge_child, by its local id) ─▶ routed on no cloud space; a target
 *      below 7 ─▶ refused{fleet.upgrade_required}
 *   ─▶ archive_space / unarchive_space (protocol 9) ─▶ routed like stop; a
 *      target below 9 ─▶ refused{fleet.upgrade_required}
 * POST /v1/fleet/request ─▶ routed like a socket request
 * ```
 *
 * A space's followers are its origin and the origin's live delegates
 * (docs/mobile.md "Following a computer's spaces"); its host is never one.
 * A host's confirms (Claude via the cloud waiting for a person's yes) go to
 * the host's own live delegates, never to an `mcp` device.
 *
 * The cloud reads signed bodies only to route and checks event, ask and
 * reply signatures against the sender's pinned key (devices check them
 * again). Its own refusals are `refused`, never a `reply`.
 *
 * State lives in SQLite and in each socket's attachment, so a hibernated
 * hub wakes with nothing to rebuild. Messages run one at a time, in order.
 * Nothing here logs a token or an envelope body.
 */
import type {
  AskVia,
  ClientMessage,
  Delegation,
  DeviceInfo,
  DeviceSummary,
  DismissReason,
  RemoteAsk,
  RemoteConfirm,
  ServerMessage,
  SignedEnvelope,
  SpaceEventBody,
} from '../gen/fleet';
import { CloudError } from '../errors';
import { noopLogger, type Logger } from '../telemetry/log';
import {
  ACTIVE_IDLE_MS,
  ALARM_RETRY_MS,
  close,
  closeCodeFor,
  codes,
  ESCALATE_MS,
  GONE_USER_MS,
  GRACE_MS,
  HELLO_TIMEOUT_MS,
  HOST_OFFLINE_PRUNE_MS,
  MAX_ASKS_PER_SPACE,
  MAX_ASKS_PER_USER,
  MAX_CHILDREN,
  MAX_CONFIRMS_PER_USER,
  MAX_CONNS_PER_USER,
  MAX_DEPTH,
  MAX_DEVICES_PER_USER,
  MAX_FRAME_BYTES,
  MAX_PENDING_PER_USER,
  MAX_SPACES_PER_USER,
  MAX_USER_EVENT_BYTES,
  MIRROR_KEPT,
  NONCE_BYTES,
  PENDING_TTL_MS,
  PROTOCOL_VERSION,
  PUSH_ACTIONS,
  PUSH_BODY_CHARS,
  PUSH_PER_MINUTE,
  RATE_BURST,
  RATE_PER_SECOND,
  REAUTH_LEEWAY_MS,
  REQUEST_WINDOW_MS,
} from './limits';
import {
  askPresentation,
  clip,
  confirmPush,
  type PushMessage,
  type PushSender,
} from './push';
import {
  DATA_TABLES,
  Store,
  type AskRow,
  type ConfirmRow,
  type DelegationRow,
  type DeviceRow,
  type PendingRow,
  type PushTokenRow,
  type Sql,
  type SpaceRow,
} from './store';
import {
  type Domain,
  type ReplyRouting,
  type Routing,
  b64,
  BadMessage,
  byteLength,
  hosts,
  parseClient,
  peekAsk,
  peekConfirm,
  peekDelegation,
  peekEvent,
  peekReply,
  peekRequest,
  archives,
  onAnySpace,
  protocolFor,
  protocolToSee,
  unb64,
  V6,
  verifyEnvelope,
  verifyHello,
} from './wire';

/** Who opened the socket, as the Worker verified it. */
export interface FleetCaller {
  userId: string;
  orgId: string;
  sessionId?: string;
  /** Access token expiry, unix ms. */
  expMs: number;
}

export interface Presence {
  focused: boolean;
  locked: boolean;
  idleMs: number;
  atMs: number;
}

/** A socket's attachment: survives hibernation (keep it under 2 KiB). */
export interface ConnState {
  id: string;
  user: string;
  org: string;
  expMs: number;
  phase: 'challenged' | 'ready' | 'closed';
  nonce?: string;
  device?: string;
  generation?: number;
  /** The hello's protocol; absent on attachments older than v4 (= 3). */
  protocol?: number;
  /**
   * The cloud's own MCP device (src/mcp/), connected in process: the only
   * connection whose hello may say kind `mcp`. Never set for a socket.
   */
  internal?: boolean;
  presence?: Presence;
  /**
   * The last reauth couldn't be checked (signing keys unreachable): when
   * the deadline passes, the close is `fleet.unavailable` (1011, redial),
   * not `fleet.unauthorized` (4001, fatal).
   */
  authUnavailable?: boolean;
}

export interface Conn {
  readonly open: boolean;
  state(): ConnState;
  save(state: ConnState): void;
  send(text: string): void;
  close(code: number, reason: string): void;
}

/** What `reauth` needs from a token: same shape as `verifyAccessToken`. */
export interface VerifiedToken {
  userId: string;
  organizationId?: string;
  expiresAt?: number;
}

export interface HubEnv {
  sql: Sql;
  now(): number;
  /** Open sockets, all or one user's. */
  conns(userId?: string): Conn[];
  verify(token: string): Promise<VerifiedToken>;
  /** Wake `alarm()` at or before this unix ms; null: nothing due. */
  schedule(atMs: number | null): void | Promise<void>;
  /** Push notifications out (Expo); absent: none are sent. */
  push?: PushSender;
  /** Keeps work alive past the message (`ctx.waitUntil`); never awaited. */
  defer?(work: Promise<unknown>): void;
  /** Structured logs (docs/telemetry.md "Cloud"); absent: none. */
  log?: Logger;
}

/** Refusals that mean a per-user limit was reached (logged as `quota hit`). */
const QUOTA_CODES: ReadonlySet<string> = new Set([
  codes.TOO_MANY_DEVICES,
  codes.TOO_MANY_CONNECTIONS,
  codes.TOO_MANY_SPACES,
  codes.BUSY,
]);

/** What `POST /v1/fleet/request` answers. */
export type HttpRequestOutcome =
  | { accepted: true; req_id: string }
  | {
      accepted: false;
      req_id: string | null;
      refused: { code: string; message: string };
    };

/** A request routed (or not) by `Hub.route`. */
type RouteOutcome =
  | { kind: 'routed'; req_id: string }
  | { kind: 'refused'; req_id: string; code: string; message: string }
  | { kind: 'error'; code: string; message: string };

/** Statuses that end a turn: a space's followers get a push for them. */
const FINISHED = ['idle', 'failed', 'stopped'];

/** Protocol 3 knew neither phones nor delegations. */
const V4 = 4;

interface Ready {
  conn: Conn;
  state: ConnState & { device: string; generation: number };
}

type Of<T extends ClientMessage['type']> = Extract<ClientMessage, { type: T }>;

export class Hub {
  readonly store: Store;
  private readonly log: Logger;
  private chain: Promise<void> = Promise.resolve();
  /** Set by an alarm that left a row due: no alarm sooner than this. */
  private alarmRetryAt: number | null = null;
  private buckets = new Map<
    string,
    { tokens: number; at: number; warned: number }
  >();

  constructor(private env: HubEnv) {
    this.store = new Store(env.sql);
    this.log = env.log ?? noopLogger;
  }

  // ── entry points ───────────────────────────────────────────────────────

  /**
   * A new connection: one challenge. `internal`: the cloud's own MCP
   * device's in-process connection (src/mcp/fleet.ts), never a socket.
   */
  open(conn: Conn, caller: FleetCaller, internal = false): Promise<void> {
    return this.run(() => {
      // One challenge per connection: a device signs one nonce per socket.
      if (stateOf(conn)) return;
      if (this.isGone(caller.userId)) {
        conn.save({
          id: crypto.randomUUID(),
          user: caller.userId,
          org: caller.orgId,
          expMs: caller.expMs,
          phase: 'challenged',
          ...(internal ? { internal: true } : {}),
        });
        return this.fail(conn, codes.UNAUTHORIZED, 'the account was deleted');
      }
      const others = this.env
        .conns(caller.userId)
        .filter((c) => c !== conn && c.open && stateOf(c)?.phase !== 'closed');
      const nonce = new Uint8Array(NONCE_BYTES);
      crypto.getRandomValues(nonce);
      const state: ConnState = {
        id: crypto.randomUUID(),
        user: caller.userId,
        org: caller.orgId,
        expMs: caller.expMs,
        phase: 'challenged',
        nonce: b64(nonce),
        ...(internal ? { internal: true } : {}),
      };
      if (others.length >= MAX_CONNS_PER_USER) {
        conn.save({ ...state, nonce: undefined });
        return this.fail(
          conn,
          codes.TOO_MANY_CONNECTIONS,
          `at most ${MAX_CONNS_PER_USER} connections per user`,
        );
      }
      conn.save(state);
      this.store.setDeadline(
        state.id,
        state.user,
        this.env.now() + HELLO_TIMEOUT_MS,
      );
      this.send(conn, { type: 'challenge', nonce: state.nonce! });
    });
  }

  message(conn: Conn, data: string | ArrayBuffer): Promise<void> {
    const size = typeof data === 'string' ? byteLength(data) : data.byteLength;
    if (size > MAX_FRAME_BYTES) {
      return this.run(() =>
        this.fail(conn, codes.TOO_LARGE, 'frame too large'),
      );
    }
    const st = stateOf(conn);
    if (!st) {
      // A socket with no state (never saved, or lost with the attachment):
      // nothing here can be trusted, so it is closed, and the device redials.
      return this.run(() => {
        try {
          conn.close(close.POLICY, codes.BAD_MESSAGE);
        } catch {
          // already closing
        }
      });
    }
    if (!this.allow(conn, st.id)) return Promise.resolve();
    return this.run(async () => {
      if (!conn.open) return;
      const s = conn.state();
      if (s.phase === 'closed') return;
      if (typeof data !== 'string') {
        return this.error(conn, codes.BAD_MESSAGE, 'text frames only');
      }
      let msg;
      try {
        msg = parseClient(
          data,
          s.phase === 'challenged' ? PROTOCOL_VERSION : protocolOf(s),
          s.internal === true,
        );
      } catch (e) {
        if (!(e instanceof BadMessage)) throw e;
        if (s.phase === 'challenged') return this.fail(conn, e.code, e.message);
        return this.error(conn, e.code, e.message);
      }
      if (s.phase === 'challenged') {
        if (msg.type !== 'hello') {
          // A protocol slip, not an auth failure: the device may redial.
          return this.fail(conn, codes.BAD_MESSAGE, 'hello first');
        }
        return this.hello(conn, s, msg);
      }
      const r = this.asReady(conn, s);
      if (!r) return;
      switch (msg.type) {
        case 'hello':
          return this.error(conn, codes.BAD_MESSAGE, 'already said hello');
        case 'reauth':
          return this.reauth(r, msg);
        case 'presence':
          return this.presence(r, msg);
        case 'announce':
          return this.announce(r, msg.info);
        case 'request':
          return this.request(r, msg);
        case 'claim':
          return this.claim(r, msg);
        case 'reply':
          return this.reply(r, msg);
        case 'space_event':
          return this.spaceEvent(r, msg.envelope);
        case 'subscribe':
          return this.subscribe(r, msg);
        case 'unsubscribe':
          this.store.run(
            'DELETE FROM subs WHERE device_id = ? AND space = ?',
            r.state.device,
            msg.space,
          );
          return;
        case 'ask':
          return this.ask(r, msg.envelope);
        case 'ask_resolved':
          return this.askResolved(r, msg.ask_id);
        case 'remove_device':
          return this.removeDevice(r, msg.device_id);
        case 'register_push':
          return this.registerPush(r, msg);
        case 'delegate':
          return this.delegate(r, msg.envelope);
        case 'confirm':
          return this.confirm(r, msg.envelope);
        case 'confirm_resolved':
          return this.confirmResolved(r, msg.confirm_id);
      }
    });
  }

  /** The device closed (or lost) the socket; `code` as the runtime saw it. */
  closed(conn: Conn, code?: number): Promise<void> {
    return this.run(() => {
      const s = stateOf(conn);
      if (!s) return; // never opened: nothing of it anywhere
      this.buckets.delete(s.id);
      this.store.run('DELETE FROM conns WHERE conn_id = ?', s.id);
      // `closed`: replaced, or failed (cleaned up then: logged there).
      if (s.phase !== 'closed') {
        this.log.info('fleet disconnected', {
          ...this.connAttrs(s),
          by: 'device',
          close_code: code,
        });
      }
      if (s.phase === 'ready') this.gone(s);
    });
  }

  /** What a log line says about a connection: ids and kinds, nothing else. */
  private connAttrs(s: ConnState | null): Record<string, unknown> {
    if (!s) return {};
    const dev = s.device ? this.store.device(s.device) : undefined;
    return {
      user_id: s.user,
      org_id: s.org,
      device_id: s.device,
      device_kind: dev ? infoOf(dev).kind : undefined,
      protocol: s.protocol,
      phase: s.phase,
      internal: s.internal === true ? true : undefined,
    };
  }

  /**
   * The MCP device's in-process connection stays up until `expMs` (+ the
   * usual leeway): it is online while an MCP client keeps using it. Sockets
   * extend theirs only with a verified `reauth`.
   */
  extend(conn: Conn, expMs: number): Promise<void> {
    return this.run(() => {
      if (!conn.open) return;
      const s = conn.state();
      if (!s?.internal || s.phase !== 'ready') return;
      s.expMs = expMs;
      conn.save(s);
      this.store.setDeadline(s.id, s.user, expMs + REAUTH_LEEWAY_MS);
      this.store.run(
        'UPDATE devices SET last_seen_ms = ? WHERE device_id = ?',
        this.env.now(),
        s.device ?? null,
      );
    });
  }

  /** Whether `user`'s account was deleted (recently: GONE_USER_MS). */
  isGone(user: string): boolean {
    return (
      this.store.one(
        'SELECT 1 AS x FROM gone_users WHERE user_id = ? AND until_ms > ?',
        user,
        this.env.now(),
      ) !== undefined
    );
  }

  /**
   * The account `user` is deleted (DELETE /v1/account): its connections
   * closed for good (4001), every row of it gone, and the user refused for
   * GONE_USER_MS. Nobody else's rows are touched: every row here belongs to
   * one user, and spaces, requests, questions and delegations never cross
   * users. Idempotent. Throws (unlike a message) if a statement fails.
   */
  purgeUser(user: string): Promise<void> {
    return this.runOrThrow(() => {
      this.markGone(user);
      this.closeAll(user);
      const devices = this.store
        .rows<{
          device_id: string;
        }>('SELECT device_id FROM devices WHERE user_id = ?', user)
        .map((d) => d.device_id);
      this.store.dropSpaces(
        this.store
          .rows<{
            space: string;
          }>('SELECT space FROM spaces WHERE user_id = ?', user)
          .map((x) => x.space),
      );
      for (const t of ['asks', 'confirms', 'pending', 'push_tokens']) {
        this.store.run(`DELETE FROM ${t} WHERE user_id = ?`, user);
      }
      for (const d of devices) {
        this.store.run('DELETE FROM replies WHERE origin_device = ?', d);
        this.store.run('DELETE FROM subs WHERE device_id = ?', d);
        this.store.run('DELETE FROM push_tokens WHERE device_id = ?', d);
        this.store.run(
          `DELETE FROM delegations
           WHERE origin_device = ? OR delegate_device = ?`,
          d,
          d,
        );
      }
      this.store.run('DELETE FROM delegations WHERE user_id = ?', user);
      this.store.run('DELETE FROM conns WHERE user_id = ?', user);
      this.store.run('DELETE FROM devices WHERE user_id = ?', user);
    });
  }

  /**
   * The whole org's fleet state dropped (a deleted personal org): every
   * connection closed for good, every table emptied; `user` refused as by
   * `purgeUser`.
   */
  purgeAll(user: string): Promise<void> {
    return this.runOrThrow(() => {
      this.markGone(user);
      this.closeAll();
      for (const t of DATA_TABLES) this.store.run(`DELETE FROM ${t}`);
    });
  }

  private markGone(user: string) {
    this.store.run(
      `INSERT INTO gone_users (user_id, until_ms) VALUES (?, ?)
       ON CONFLICT (user_id) DO UPDATE SET until_ms = excluded.until_ms`,
      user,
      this.env.now() + GONE_USER_MS,
    );
  }

  /** Closes connections (one user's, or all) for good: 4001, no redial. */
  private closeAll(user?: string) {
    for (const conn of this.env.conns(user)) {
      if (!conn.open) continue;
      const s = stateOf(conn);
      if (s) {
        this.buckets.delete(s.id);
        this.store.run('DELETE FROM conns WHERE conn_id = ?', s.id);
        // `closed`: its close handler then cleans nothing up (no `gone`).
        s.phase = 'closed';
        conn.save(s);
      }
      this.error(conn, codes.UNAUTHORIZED, 'the account was deleted');
      try {
        conn.close(closeCodeFor(codes.UNAUTHORIZED), codes.UNAUTHORIZED);
      } catch {
        // already closing
      }
    }
  }

  /** `user`'s devices as `devices` lists them (every kind, protocol 5). */
  listDevices(user: string): DeviceSummary[] {
    const online = new Set(this.ready(user).map((c) => c.state.device));
    return this.store
      .rows<DeviceRow>(
        'SELECT * FROM devices WHERE user_id = ? ORDER BY device_id',
        user,
      )
      .map((d) => ({
        device_id: d.device_id,
        info: JSON.parse(d.info) as DeviceInfo,
        online: online.has(d.device_id),
        last_seen_ms: d.last_seen_ms,
        public_key: d.public_key,
      }));
  }

  /** A device's current connection ended: offline, subs dropped. */
  private gone(s: ConnState) {
    if (!s.device) return;
    const dev = this.store.device(s.device);
    // A replaced connection: the newer one owns the device now.
    if (!dev || dev.generation !== s.generation) return;
    const now = this.env.now();
    this.store.run(
      'UPDATE devices SET last_seen_ms = ? WHERE device_id = ?',
      now,
      s.device,
    );
    this.store.run('DELETE FROM subs WHERE device_id = ?', s.device);
    this.store.run(
      `UPDATE pending SET grace_until = ?
       WHERE target_device = ? AND claimed = 0 AND grace_until IS NULL`,
      now + GRACE_MS,
      s.device,
    );
    this.pushDevices(s.user, s.id);
  }

  /**
   * Everything due by now, each step on its own: a row the hub can't
   * handle (a socket whose attachment is gone, a stored envelope that
   * won't parse) is logged and skipped, never left in the way of the rows
   * after it. Every due row is cleared (deleted or marked) before the work
   * it brings, so a failure in that work can't keep it due. `reschedule`
   * then finds the next deadline; were any row still due, the hub would
   * wake again at once, in a loop: that is logged as `fleet alarm stuck`
   * and retried after ALARM_RETRY_MS instead.
   */
  alarm(): Promise<void> {
    return this.run(() => {
      const now = this.env.now();
      for (const row of this.store.rows<{ conn_id: string; user_id: string }>(
        'SELECT conn_id, user_id FROM conns WHERE deadline_ms <= ?',
        now,
      )) {
        this.store.run('DELETE FROM conns WHERE conn_id = ?', row.conn_id);
        this.attempt('close expired connection', () =>
          this.closeExpired(row.user_id, row.conn_id),
        );
      }
      for (const p of this.store.rows<PendingRow>(
        `SELECT * FROM pending
         WHERE (claimed = 0 AND grace_until <= ?) OR created_ms + ttl_ms <= ?`,
        now,
        now,
      )) {
        this.store.run('DELETE FROM pending WHERE req_id = ?', p.req_id);
        this.attempt('refuse unanswered request', () =>
          this.deliver(p.user_id, p.origin_device, p.req_id, {
            type: 'refused',
            req_id: p.req_id,
            code: codes.OFFLINE,
            message: 'the device did not answer in time',
          }),
        );
      }
      this.attempt('drop old replies', () =>
        this.store.run(
          'DELETE FROM replies WHERE created_ms <= ?',
          now - PENDING_TTL_MS,
        ),
      );
      for (const a of this.store.rows<AskRow>(
        'SELECT * FROM asks WHERE escalated = 0 AND created_ms <= ?',
        now - ESCALATE_MS,
      )) {
        this.attempt('escalate question', () => this.escalate(a));
      }
      for (const c of this.store.rows<ConfirmRow>(
        'SELECT * FROM confirms WHERE expires_at_ms <= ?',
        now,
      )) {
        this.attempt('drop lapsed confirm', () => this.dropConfirm(c));
      }
      this.attempt('prune stale spaces', () => this.pruneStale(now));
      this.attempt('prune delegations', () => this.pruneDelegations(now));
      this.attempt('forget deleted users', () =>
        this.store.run('DELETE FROM gone_users WHERE until_ms <= ?', now),
      );
      const stuck = this.dueTerms().filter((t) => t.at <= now);
      if (stuck.length === 0) {
        this.alarmRetryAt = null;
        return;
      }
      this.log.warn('fleet alarm stuck', {
        code: codes.INTERNAL,
        terms: stuck.map((t) => t.term).join(','),
        late_ms: now - Math.min(...stuck.map((t) => t.at)),
      });
      this.alarmRetryAt = now + ALARM_RETRY_MS;
    });
  }

  /** One step of the alarm; a failure is logged, and the next step runs. */
  private attempt(step: string, fn: () => void) {
    try {
      fn();
    } catch (e) {
      // The error only: a row may carry a signed body.
      this.log.exception('fleet alarm step failed', e, {
        code: codes.INTERNAL,
        step,
      });
    }
  }

  /** The socket of a connection past its deadline (its row already gone). */
  private closeExpired(user: string, connId: string) {
    // A socket with no state yet (never saved, or lost) is not this one.
    const conn = this.env
      .conns(user)
      .find((c) => c.open && stateOf(c)?.id === connId);
    if (!conn) return;
    const st = conn.state();
    if (st.phase === 'challenged') {
      // Slow, not unauthorized: the device may redial.
      this.fail(conn, codes.BAD_MESSAGE, 'no hello in time');
    } else if (st.authUnavailable) {
      // Its newer token was never checked, through no fault of its own:
      // it redials, and the Worker checks the token then.
      this.fail(conn, codes.UNAVAILABLE, 'signing keys unavailable');
    } else {
      this.fail(conn, codes.UNAUTHORIZED, 'access token expired');
    }
  }

  // ── connect ────────────────────────────────────────────────────────────

  private async hello(conn: Conn, s: ConnState, msg: Of<'hello'>) {
    // Spent on the first hello, good or bad: the nonce is never reused.
    const nonce = unb64(s.nonce ?? '');
    s.nonce = undefined;
    conn.save(s);
    if (!nonce || !(await verifyHello(msg.public_key, nonce, msg.signature))) {
      return this.fail(conn, codes.BAD_SIGNATURE, 'challenge not signed');
    }
    if (!conn.open) return;
    const now = this.env.now();
    let dev = msg.device_id ? this.store.device(msg.device_id) : undefined;
    if (dev && (dev.user_id !== s.user || dev.public_key !== msg.public_key)) {
      return this.fail(conn, codes.KEY_MISMATCH, 'not this device’s key');
    }
    // Lost its id but kept its key: the same device, not a new one.
    dev ??= this.store.one<DeviceRow>(
      'SELECT * FROM devices WHERE user_id = ? AND public_key = ?',
      s.user,
      msg.public_key,
    );
    const info = JSON.stringify(msg.info);
    let deviceId: string;
    let generation: number;
    if (dev) {
      deviceId = dev.device_id;
      generation = dev.generation + 1;
      this.store.run(
        `UPDATE devices SET info = ?, generation = ?, last_seen_ms = ?
         WHERE device_id = ?`,
        info,
        generation,
        now,
        deviceId,
      );
    } else {
      const count =
        this.store.num(
          'SELECT COUNT(*) AS n FROM devices WHERE user_id = ?',
          s.user,
        ) ?? 0;
      if (count >= MAX_DEVICES_PER_USER) {
        return this.fail(
          conn,
          codes.TOO_MANY_DEVICES,
          `at most ${MAX_DEVICES_PER_USER} devices per user`,
        );
      }
      deviceId = `dev_${crypto.randomUUID()}`;
      generation = 1;
      this.store.run(
        `INSERT INTO devices
         (device_id, user_id, public_key, info, generation, last_seen_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        deviceId,
        s.user,
        msg.public_key,
        info,
        generation,
        now,
      );
    }

    // After its own last_seen moved: a host back from a long absence keeps
    // its spaces.
    this.pruneStale(now);

    // One connection per device: the newer wins.
    for (const old of this.ready(s.user)) {
      if (old.state.device === deviceId && old.state.id !== s.id) {
        old.state.phase = 'closed';
        old.conn.save(old.state);
        old.conn.close(close.REPLACED, 'replaced by a newer connection');
      }
    }
    s.phase = 'ready';
    s.device = deviceId;
    s.generation = generation;
    s.protocol = msg.protocol;
    conn.save(s);
    this.store.setDeadline(s.id, s.user, s.expMs + REAUTH_LEEWAY_MS);
    this.store.run('DELETE FROM subs WHERE device_id = ?', deviceId);
    this.log.info('fleet connected', {
      ...this.connAttrs(s),
      device_kind: msg.info.kind,
      os: msg.info.os,
      app_version: msg.info.app_version,
      new_device: !dev,
    });

    const resume: Record<string, number> = {};
    for (const sp of this.store.rows<{ space: string; last_seq: number }>(
      'SELECT space, last_seq FROM spaces WHERE host_device = ?',
      deviceId,
    )) {
      resume[sp.space] = sp.last_seq;
    }
    this.send(conn, {
      type: 'welcome',
      device_id: deviceId,
      generation,
      resume,
    });
    this.pushDevices(s.user);
    if (msg.protocol >= V4) {
      this.send(conn, {
        type: 'delegations',
        list: this.delegationsNaming(deviceId),
      });
    }

    // Unclaimed requests for it, under the new generation.
    this.store.run(
      `UPDATE pending SET generation = ?, grace_until = NULL
       WHERE target_device = ? AND claimed = 0`,
      generation,
      deviceId,
    );
    for (const p of this.store.rows<PendingRow>(
      'SELECT * FROM pending WHERE target_device = ? AND claimed = 0 ORDER BY created_ms',
      deviceId,
    )) {
      // Sent while it was away, for an op its protocol doesn't have.
      if (msg.protocol < protocolFor(p.op)) {
        this.store.run('DELETE FROM pending WHERE req_id = ?', p.req_id);
        this.deliver(p.user_id, p.origin_device, p.req_id, {
          type: 'refused',
          req_id: p.req_id,
          code: codes.UPGRADE_REQUIRED,
          message: upgradeWords(p.op),
        });
        continue;
      }
      this.send(conn, {
        type: 'request',
        envelope: JSON.parse(p.envelope),
        generation,
      });
    }
    // Replies and refusals that came while it was away.
    for (const r of this.store.rows<{ message: string }>(
      'SELECT message FROM replies WHERE origin_device = ? ORDER BY created_ms',
      deviceId,
    )) {
      this.send(conn, JSON.parse(r.message) as ServerMessage);
    }
    this.store.run('DELETE FROM replies WHERE origin_device = ?', deviceId);
    // Open questions it was showing, or escalated ones of spaces it follows.
    for (const a of this.store.rows<AskRow>(
      'SELECT * FROM asks WHERE user_id = ? ORDER BY created_ms',
      s.user,
    )) {
      if (a.host_device === deviceId) continue;
      const shown = shownOn(a);
      if (shown.includes(deviceId)) {
        this.showAsk(conn, a, (a.via ?? 'escalated') as AskVia);
      } else if (a.escalated && this.followers(a).includes(deviceId)) {
        this.showAsk(conn, a, 'escalated');
        this.setShown(a.ask_id, [...shown, deviceId]);
      }
    }
    // Confirms waiting on the hosts it is a delegate of.
    this.showConfirms(s.user, deviceId);
  }

  /**
   * A refreshed token. Refused for what it is (JOSE or claim errors): an
   * `error{fleet.unauthorized}`, which the device takes as fatal. Not
   * checked because the signing keys are unreachable: nothing is said
   * now, the old deadline stands, and the close it brings is non-fatal
   * (`alarm`), so a JWKS outage never ends a device's fleet for good.
   */
  private async reauth(r: Ready, msg: Of<'reauth'>) {
    let t: VerifiedToken;
    try {
      t = await this.env.verify(msg.access_token);
    } catch (e) {
      if (!r.conn.open) return;
      const s = r.conn.state();
      s.authUnavailable = !badToken(e);
      r.conn.save(s);
      if (s.authUnavailable) return;
      return this.error(r.conn, codes.UNAUTHORIZED, 'access token refused');
    }
    if (!r.conn.open) return;
    if (t.userId !== r.state.user) {
      return this.fail(r.conn, codes.UNAUTHORIZED, 'token is for another user');
    }
    if (t.organizationId !== r.state.org) {
      return this.fail(r.conn, codes.NO_ORG, 'token is for another org');
    }
    const s = r.conn.state();
    s.expMs = (t.expiresAt ?? 0) * 1000;
    s.authUnavailable = undefined;
    r.conn.save(s);
    this.store.setDeadline(s.id, s.user, s.expMs + REAUTH_LEEWAY_MS);
    // A long-lived connection stays fresh for the 30-day prune.
    this.store.run(
      'UPDATE devices SET last_seen_ms = ? WHERE device_id = ?',
      this.env.now(),
      r.state.device,
    );
  }

  private announce(r: Ready, info: DeviceInfo) {
    this.store.run(
      'UPDATE devices SET info = ? WHERE device_id = ?',
      JSON.stringify(info),
      r.state.device,
    );
    this.pushDevices(r.state.user);
  }

  // ── requests ───────────────────────────────────────────────────────────

  private request(r: Ready, msg: Of<'request'>) {
    const out = this.routed(r.state.user, r.state.device, msg.envelope, 'ws');
    if (out.kind === 'error') return this.error(r.conn, out.code, out.message);
    if (out.kind === 'refused') {
      const { req_id, code, message } = out;
      this.send(r.conn, { type: 'refused', req_id, code, message });
    }
  }

  /**
   * `POST /v1/fleet/request`: a one-shot signed request from `deviceId`
   * (a notification action, no socket), routed like a socket `request`.
   * The target's reply reaches the origin later, over its socket (held
   * 2 min while it's away).
   */
  requestOverHttp(
    caller: FleetCaller,
    deviceId: string,
    envelope: SignedEnvelope,
  ): Promise<HttpRequestOutcome> {
    let out: HttpRequestOutcome = {
      accepted: false,
      req_id: null,
      refused: { code: codes.INTERNAL, message: 'internal error' },
    };
    return this.run(() => {
      const dev = this.store.device(deviceId);
      // The MCP device's key lives in the cloud: it sends only in process.
      const r: RouteOutcome =
        !dev || dev.user_id !== caller.userId || infoOf(dev).kind === 'mcp'
          ? { kind: 'error', code: codes.NOT_YOURS, message: 'no such device' }
          : this.routed(caller.userId, deviceId, envelope, 'http');
      out =
        r.kind === 'routed'
          ? { accepted: true, req_id: r.req_id }
          : {
              accepted: false,
              req_id: r.kind === 'refused' ? r.req_id : null,
              refused: { code: r.code, message: r.message },
            };
    }).then(() => out);
  }

  /** `route`, with one `fleet request` line: op, outcome, code, latency. */
  private routed(
    user: string,
    sender: string,
    envelope: SignedEnvelope,
    via: 'ws' | 'http',
  ): RouteOutcome {
    const started = Date.now();
    const out = this.route(user, sender, envelope);
    let op: string | undefined;
    try {
      op = peekRequest(envelope.body).op;
    } catch {
      // not a request: the outcome says so
    }
    const origin = this.store.device(sender);
    const attrs = {
      user_id: user,
      op,
      via,
      outcome: out.kind,
      code: out.kind === 'routed' ? undefined : out.code,
      origin_kind: origin ? infoOf(origin).kind : undefined,
      ms: Date.now() - started,
    };
    this.log.info('fleet request', attrs);
    if (out.kind === 'refused' && QUOTA_CODES.has(out.code)) {
      this.log.info('quota hit', { user_id: user, code: out.code, op });
    }
    return out;
  }

  /** Routes `envelope`, sent by `sender` (one of `user`'s devices). */
  private route(
    user: string,
    sender: string,
    envelope: SignedEnvelope,
  ): RouteOutcome {
    let parsed: Routing;
    try {
      parsed = peekRequest(envelope.body);
    } catch (e) {
      if (!(e instanceof BadMessage)) throw e;
      return { kind: 'error', code: e.code, message: e.message };
    }
    const route = parsed;
    const refuse = (code: string, message: string): RouteOutcome => ({
      kind: 'refused',
      req_id: route.req_id,
      code,
      message,
    });
    if (envelope.device_id !== sender || route.origin_device !== sender) {
      return refuse(codes.NOT_YOURS, 'a request must come from its origin');
    }
    if (route.target_device === route.origin_device) {
      return refuse(codes.INVALID, 'a device can’t send a request to itself');
    }
    const target = this.store.device(route.target_device);
    if (!target || target.user_id !== user) {
      return refuse(codes.NOT_YOURS, 'no such device');
    }
    // Phones and browsers follow spaces; they never run one.
    if (!hosts(infoOf(target).kind)) {
      return refuse(codes.INVALID, 'that device runs no spaces');
    }
    // A phone's or the web app's request to a computer on protocol 3 (the
    // MCP device's to one below 5): that computer never lists the origin,
    // so it can't trust it and would only show a dead-end prompt. Say so.
    const origin = this.store.device(sender);
    const targetConn = this.readyDevice(user, route.target_device);
    // A person's yes (or no), or the auto mode that skips asking: on no
    // space, and never from Claude via the cloud itself (the host refuses
    // that too). The ops on any of the target's own spaces are on no space
    // the cloud tracks either, but anyone may send them (the target decides).
    const personOnly = route.op === 'confirm' || route.op === 'set_mcp_auto';
    const onSpace = !personOnly && !onAnySpace(route.op);
    if (personOnly && (!origin || infoOf(origin).kind === 'mcp')) {
      return refuse(
        codes.NOT_YOURS,
        'Claude via the cloud can’t answer its own requests or set auto mode',
      );
    }
    if (targetConn && protocolOf(targetConn.state) < protocolFor(route.op)) {
      return refuse(codes.UPGRADE_REQUIRED, upgradeWords(route.op));
    }
    if (
      origin &&
      targetConn &&
      protocolOf(targetConn.state) < protocolToSee(infoOf(origin).kind)
    ) {
      return refuse(
        codes.UPGRADE_REQUIRED,
        'that computer runs an older Theodore: update it to take requests from a phone, the web or Claude',
      );
    }
    // The target checks this too: a key the cloud doesn't pin for that id
    // was signed for another machine.
    if (route.target_key !== target.public_key) {
      return refuse(codes.NOT_YOURS, 'not that device’s key');
    }
    const existing = this.store.pending(route.req_id);
    if (existing) {
      return {
        kind: 'error',
        code: codes.BAD_MESSAGE,
        message: 'req_id already pending',
      };
    }
    const open =
      this.store.num(
        'SELECT COUNT(*) AS n FROM pending WHERE user_id = ?',
        user,
      ) ?? 0;
    if (open >= MAX_PENDING_PER_USER) {
      return refuse(codes.BUSY, 'too many requests in flight');
    }
    const space = onSpace ? this.store.space(route.space) : undefined;
    if (space && space.user_id !== user) {
      return refuse(codes.NOT_YOURS, 'no such space');
    }
    if (route.op === 'start_space') {
      // A space id is started once. A second start of a known id (or of
      // one whose start is still pending) would only be refused by the
      // target, and its refusal must not cost the space that exists.
      if (
        space ||
        this.store.one(
          `SELECT 1 AS x FROM pending WHERE op = 'start_space' AND space = ?`,
          route.space,
        )
      ) {
        return refuse(codes.INVALID, 'this space was started already');
      }
      const parent = route.parent ? this.store.space(route.parent) : undefined;
      if (parent && parent.user_id !== user) {
        return refuse(codes.NOT_YOURS, 'no such parent space');
      }
      const why = this.depthRefusal(user, route.parent, route.depth);
      if (why) return refuse(codes.DEPTH, why);
      if (!space && !this.roomForSpace(user)) {
        return refuse(
          codes.TOO_MANY_SPACES,
          `at most ${MAX_SPACES_PER_USER} spaces per user`,
        );
      }
    }
    // An answer dismisses the question elsewhere only once the host took it
    // (its `ok` reply): a refused answer leaves it open everywhere.

    const now = this.env.now();
    const to = this.readyDevice(user, target.device_id);
    const forward = forwardOf(envelope);
    this.store.run(
      `INSERT INTO pending (req_id, user_id, origin_device, target_device,
         generation, claimed, created_ms, grace_until, envelope, op, space,
         parent, depth, ask_id, ttl_ms)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      route.req_id,
      user,
      route.origin_device,
      target.device_id,
      target.generation,
      now,
      to ? null : now + GRACE_MS,
      JSON.stringify(forward),
      route.op,
      route.space,
      route.parent,
      route.depth,
      route.ask_id,
      // The MCP device's edits and runs wait on the host for a person's
      // yes, up to the request window: its requests live that long here.
      origin && infoOf(origin).kind === 'mcp'
        ? REQUEST_WINDOW_MS
        : PENDING_TTL_MS,
    );
    if (to) {
      this.send(to.conn, {
        type: 'request',
        envelope: forward,
        generation: target.generation,
      });
    }
    return { kind: 'routed', req_id: route.req_id };
  }

  /** MAX_DEPTH / MAX_CHILDREN, as the origin core checks them too. */
  private depthRefusal(
    user: string,
    parent: string | null,
    depth: number,
  ): string | null {
    if (depth > MAX_DEPTH) return `deeper than ${MAX_DEPTH}`;
    if (parent === null) return null;
    const p = this.store.space(parent);
    if (p && depth !== p.depth + 1) return 'depth must be the parent’s + 1';
    if (!p && depth < 1) return 'a child space has depth ≥ 1';
    const children =
      (this.store.num(
        'SELECT COUNT(*) AS n FROM spaces WHERE parent = ? AND user_id = ?',
        parent,
        user,
      ) ?? 0) +
      (this.store.num(
        `SELECT COUNT(*) AS n FROM pending
         WHERE op = 'start_space' AND parent = ? AND user_id = ?`,
        parent,
        user,
      ) ?? 0);
    if (children >= MAX_CHILDREN) return `more than ${MAX_CHILDREN} children`;
    return null;
  }

  /**
   * Whether the user may have one more space (pending starts count): at the
   * cap, the oldest finished (stopped or failed) one is forgotten for it.
   */
  private roomForSpace(user: string): boolean {
    const n =
      (this.store.num(
        'SELECT COUNT(*) AS n FROM spaces WHERE user_id = ?',
        user,
      ) ?? 0) +
      (this.store.num(
        `SELECT COUNT(*) AS n FROM pending
         WHERE op = 'start_space' AND user_id = ?`,
        user,
      ) ?? 0);
    if (n < MAX_SPACES_PER_USER) return true;
    const oldest = this.store.one<{ space: string }>(
      `SELECT space FROM spaces
       WHERE user_id = ? AND status IN ('stopped', 'failed')
       ORDER BY last_ms LIMIT 1`,
      user,
    );
    if (!oldest) return false;
    this.forgetSpaces([oldest.space]);
    return n - 1 < MAX_SPACES_PER_USER;
  }

  private claim(r: Ready, msg: Of<'claim'>) {
    const p = this.store.pending(msg.req_id);
    let rejection: string | null = null;
    if (!p || p.user_id !== r.state.user) rejection = 'not_pending';
    else if (p.target_device !== r.state.device) rejection = 'wrong_target';
    else if (p.claimed) rejection = 'already_claimed';
    else if (
      msg.generation !== p.generation ||
      p.generation !== r.state.generation
    ) {
      rejection = 'stale_generation';
    }
    if (!rejection && p) {
      this.store.run(
        'UPDATE pending SET claimed = 1 WHERE req_id = ?',
        msg.req_id,
      );
      // The host starts emitting the space's events as soon as it runs the
      // claimed start, before its reply: know the space from now on, so
      // those events are kept and the origin can subscribe. A refused start
      // forgets it again (`reply`).
      if (p.op === 'start_space') this.recordSpace(p);
    }
    this.send(r.conn, {
      type: 'claim_result',
      req_id: msg.req_id,
      claimed: rejection === null,
      rejection,
    });
  }

  /**
   * A target's signed reply: checked against its pinned key and the pending
   * request, then forwarded unchanged. Its outcome (read from the body the
   * signature covers) settles the cloud's own bookkeeping.
   */
  private async reply(r: Ready, msg: Of<'reply'>) {
    const { envelope } = msg;
    let body: ReplyRouting;
    try {
      body = peekReply(envelope.body);
    } catch (e) {
      if (!(e instanceof BadMessage)) throw e;
      return this.error(r.conn, e.code, e.message);
    }
    const p = this.store.pending(body.req_id);
    if (
      !p ||
      p.user_id !== r.state.user ||
      p.target_device !== r.state.device ||
      envelope.device_id !== r.state.device ||
      body.target_device !== r.state.device
    ) {
      return this.error(r.conn, codes.NOT_YOURS, 'no such request here');
    }
    if (body.origin_device !== p.origin_device) {
      return this.error(r.conn, codes.NOT_YOURS, 'not that request’s origin');
    }
    const ok = body.outcome === 'ok';
    if (!p.claimed && ok) {
      return this.error(r.conn, codes.BAD_MESSAGE, 'claim before replying');
    }
    if (!(await this.signedBySender(r, envelope, 'reply'))) {
      return this.error(
        r.conn,
        codes.BAD_SIGNATURE,
        'reply not signed by its target',
      );
    }
    if (!r.conn.open) return;
    this.store.run('DELETE FROM pending WHERE req_id = ?', p.req_id);
    if (p.op === 'start_space') {
      if (ok) this.recordSpace(p);
      else this.forgetStart(p);
    }
    if (p.op === 'answer' && p.ask_id && ok) {
      const a = this.store.ask(p.ask_id);
      if (
        a &&
        a.user_id === p.user_id &&
        a.space === p.space &&
        a.host_device === p.target_device
      ) {
        this.dismiss(
          a,
          shownOn(a).filter((d) => d !== p.origin_device),
          'answered_elsewhere',
        );
        this.store.run('DELETE FROM asks WHERE ask_id = ?', a.ask_id);
      }
    }
    this.deliver(p.user_id, p.origin_device, p.req_id, {
      type: 'reply',
      envelope: forwardOf(envelope),
    });
  }

  /**
   * A refused start: forgets the space only if this very request made its
   * row (at its claim): same host, same origin, same `req_id`. A row made
   * by any other start stays.
   */
  private forgetStart(p: PendingRow) {
    const row = this.store.space(p.space);
    if (
      row &&
      row.req_id === p.req_id &&
      row.host_device === p.target_device &&
      row.origin_device === p.origin_device
    ) {
      this.forgetSpaces([p.space]);
    }
  }

  private recordSpace(p: PendingRow) {
    this.store.run(
      `INSERT INTO spaces
       (space, user_id, host_device, origin_device, parent, depth, last_ms,
        req_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (space) DO NOTHING`,
      p.space,
      p.user_id,
      p.target_device,
      p.origin_device,
      p.parent,
      p.depth,
      this.env.now(),
      p.req_id,
    );
  }

  /** A reply or refusal to the origin, or held 2 min while it's away. */
  private deliver(
    user: string,
    origin: string,
    reqId: string,
    msg: Extract<ServerMessage, { type: 'reply' | 'refused' }>,
  ) {
    const to = this.readyDevice(user, origin);
    if (to) {
      this.send(to.conn, msg);
      return;
    }
    this.store.run(
      `INSERT OR REPLACE INTO replies (req_id, origin_device, message, created_ms)
       VALUES (?, ?, ?, ?)`,
      reqId,
      origin,
      JSON.stringify(msg),
      this.env.now(),
    );
  }

  // ── events ─────────────────────────────────────────────────────────────

  private async spaceEvent(r: Ready, envelope: SignedEnvelope) {
    let body: SpaceEventBody;
    try {
      body = peekEvent(envelope.body);
    } catch (e) {
      if (!(e instanceof BadMessage)) throw e;
      return this.error(r.conn, e.code, e.message);
    }
    const sp = this.store.space(body.space);
    if (
      envelope.device_id !== r.state.device ||
      body.host_device !== r.state.device ||
      !sp ||
      sp.user_id !== r.state.user ||
      sp.host_device !== r.state.device
    ) {
      return this.error(
        r.conn,
        codes.NOT_YOURS,
        'not a space this device hosts',
      );
    }
    if (body.seq <= sp.last_seq) return; // a replay: already have it
    if (!(await this.signedBySender(r, envelope, 'event'))) {
      return this.error(
        r.conn,
        codes.BAD_SIGNATURE,
        'event not signed by its host',
      );
    }
    if (!r.conn.open) return;
    const forward = forwardOf(envelope);
    const text = JSON.stringify(forward);
    const ev = body.event;
    const mirror = ev.kind === 'mirror' ? ev : null;
    // A protocol-4 host compacts its journal and never journals a
    // `turn_step`: a jump in its seq is no loss. A protocol-3 host's is.
    const gap =
      protocolOf(r.state) < V4 && body.seq > sp.last_seq + 1
        ? { from: sp.last_seq + 1, to: body.seq - 1 }
        : null;
    const seen = () =>
      this.store.run(
        `UPDATE spaces SET last_seq = ?, last_ms = ?,
           lost_to = MAX(lost_to, ?) WHERE space = ?`,
        body.seq,
        this.env.now(),
        gap ? gap.to : 0,
        sp.space,
      );
    if (mirror && !isKept(mirror.model)) {
      // Live only: a finished turn's steps are in its reply's `activity`.
      seen();
      return this.fanOut(sp.user_id, sp.space, gap, forward, true);
    }
    const bytes = new TextEncoder().encode(envelope.body).byteLength;
    const started = ev.kind === 'started';
    const old = mirror
      ? this.store.mirror(sp.space, mirror.model, mirror.id)
      : undefined;
    const grow = bytes - (old?.bytes ?? 0);
    // The space's ring makes room by itself (mirrors alone over the space's
    // budget are refused); the user's budget by the oldest events of
    // finished spaces, else the event stays in the host's journal (it
    // resumes from `last_seq`).
    const ring = this.store.ringTrim(sp.space, mirror ? 0 : 1, grow);
    if (!ring.fits) {
      return this.error(r.conn, codes.BUSY, 'space event storage full');
    }
    const need = grow - ring.freed + (started ? bytes - sp.started_bytes : 0);
    let over = this.store.userBytes(sp.user_id) + need - MAX_USER_EVENT_BYTES;
    if (over > 0) over -= this.store.dropFinished(sp.user_id, sp.space, over);
    if (over > 0) {
      return this.error(r.conn, codes.BUSY, 'event storage full');
    }
    if (mirror) {
      this.store.putMirror(
        sp.space,
        mirror.model,
        mirror.id,
        body.seq,
        text,
        bytes,
        ring.upTo,
      );
    } else {
      this.store.addEvent(sp.space, body.seq, text, bytes, ring.upTo);
    }
    seen();
    this.store.run(
      `UPDATE spaces SET status = COALESCE(?, status),
         started = COALESCE(?, started),
         started_seq = COALESCE(?, started_seq),
         started_bytes = COALESCE(?, started_bytes)
       WHERE space = ?`,
      ev.kind === 'status' ? ev.status : null,
      started ? text : null,
      started ? body.seq : null,
      started ? bytes : null,
      sp.space,
    );
    this.fanOut(sp.user_id, sp.space, gap, forward, !!mirror);
    // A turn that ended (not a status repeated): one push to its followers.
    if (
      ev.kind === 'status' &&
      FINISHED.includes(ev.status) &&
      !FINISHED.includes(sp.status ?? '')
    ) {
      this.pushFinished(sp, ev.status);
    }
  }

  /** `mirror`: protocol-3 subscribers don't get it (they can't read it). */
  private fanOut(
    user: string,
    space: string,
    gap: { from: number; to: number } | null,
    envelope: SignedEnvelope,
    mirror: boolean,
  ) {
    const subs = new Set(
      this.store
        .rows<{ device_id: string }>(
          'SELECT device_id FROM subs WHERE space = ?',
          space,
        )
        .map((s) => s.device_id),
    );
    if (subs.size === 0) return;
    for (const c of this.ready(user)) {
      if (!subs.has(c.state.device)) continue;
      if (gap) this.send(c.conn, { type: 'space_gap', space, ...gap });
      if (mirror && protocolOf(c.state) < V4) continue;
      this.send(c.conn, { type: 'space_event', envelope });
    }
  }

  /**
   * History then live, for the space's host and its followers only:
   * stored events and kept mirrors after `since`, in seq order (no mirrors
   * on protocol 3). A hole is a gap only as far as `lost_to` reaches.
   */
  private subscribe(r: Ready, msg: Of<'subscribe'>) {
    const sp = this.store.space(msg.space);
    const d = r.state.device;
    if (
      !sp ||
      sp.user_id !== r.state.user ||
      (d !== sp.host_device && !this.followers(sp).includes(d))
    ) {
      return this.error(r.conn, codes.NOT_YOURS, 'no such space');
    }
    this.store.run(
      'INSERT OR IGNORE INTO subs (device_id, space) VALUES (?, ?)',
      d,
      sp.space,
    );
    if (msg.since >= sp.last_seq) return;
    const history = this.store.rows<{ seq: number; envelope: string }>(
      `SELECT seq, envelope FROM events WHERE space = ? AND seq > ?
       UNION ALL
       SELECT seq, envelope FROM mirrors WHERE space = ? AND seq > ?
       ORDER BY seq`,
      sp.space,
      msg.since,
      sp.space,
      // Protocol 3 can't read a mirror.
      protocolOf(r.state) >= V4 ? msg.since : Number.MAX_SAFE_INTEGER,
    );
    // Older than the ring: the started event (kept apart) still goes.
    const s = sp.started_seq;
    if (sp.started && s !== null && s > msg.since) {
      const at = history.findIndex((e) => e.seq >= s);
      if (at === -1) history.push({ seq: s, envelope: sp.started });
      else if (history[at]!.seq !== s) {
        history.splice(at, 0, { seq: s, envelope: sp.started });
      }
    }
    // `next`: the first seq not sent yet; a hole up to `lost_to` is a gap.
    let next = msg.since + 1;
    const hole = (to: number) => {
      const end = Math.min(to, sp.lost_to);
      if (next > end) return;
      this.send(r.conn, {
        type: 'space_gap',
        space: sp.space,
        from: next,
        to: end,
      });
    };
    for (const e of history) {
      hole(e.seq - 1);
      this.send(r.conn, {
        type: 'space_event',
        envelope: JSON.parse(e.envelope) as SignedEnvelope,
      });
      next = e.seq + 1;
    }
    hole(sp.last_seq);
  }

  // ── questions ──────────────────────────────────────────────────────────

  private async ask(r: Ready, envelope: SignedEnvelope) {
    let ask: RemoteAsk;
    try {
      ask = peekAsk(envelope.body);
    } catch (e) {
      if (!(e instanceof BadMessage)) throw e;
      return this.error(r.conn, e.code, e.message);
    }
    const user = r.state.user;
    const sp = this.store.space(ask.space);
    if (
      envelope.device_id !== r.state.device ||
      ask.host_device !== r.state.device ||
      !sp ||
      sp.user_id !== user ||
      sp.host_device !== r.state.device
    ) {
      return this.error(
        r.conn,
        codes.NOT_YOURS,
        'not a space this device hosts',
      );
    }
    const existing = this.store.ask(ask.ask_id);
    if (existing) {
      if (existing.user_id !== user || existing.space !== ask.space) {
        return this.error(r.conn, codes.NOT_YOURS, 'ask_id taken');
      }
      return; // already open
    }
    const inSpace =
      this.store.num('SELECT COUNT(*) FROM asks WHERE space = ?', sp.space) ??
      0;
    const ofUser =
      this.store.num('SELECT COUNT(*) FROM asks WHERE user_id = ?', user) ?? 0;
    if (inSpace >= MAX_ASKS_PER_SPACE || ofUser >= MAX_ASKS_PER_USER) {
      return this.error(r.conn, codes.BUSY, 'too many open questions');
    }
    if (!(await this.signedBySender(r, envelope, 'ask'))) {
      return this.error(
        r.conn,
        codes.BAD_SIGNATURE,
        'question not signed by its host',
      );
    }
    if (!r.conn.open) return;
    this.store.run(
      `INSERT INTO asks (ask_id, user_id, space, host_device, origin_device,
         envelope, shown_on, via, escalated, created_ms)
       VALUES (?, ?, ?, ?, ?, ?, '[]', NULL, 0, ?)`,
      ask.ask_id,
      user,
      ask.space,
      r.state.device,
      sp.origin_device,
      JSON.stringify(forwardOf(envelope)),
      this.env.now(),
    );
    const row = this.store.ask(ask.ask_id)!;
    const where = this.whereToAsk(row);
    if (where === 'host') return; // the host shows its own card
    if (where === null) return this.escalate(row);
    for (const d of where.devices) {
      this.showAsk(this.readyDevice(row.user_id, d)!.conn, row, where.via);
    }
    this.setShown(row.ask_id, where.devices, where.via);
    this.pushAsk(row.ask_id);
  }

  /**
   * Only the space's host and followers see its questions: the host when it
   * is your active device (it shows its own card), else the follower you're
   * at (`active`), else every follower online (`origin`), else nobody yet
   * (escalate). Another device being active doesn't pull a question to it.
   */
  private whereToAsk(
    a: AskRow,
  ): 'host' | { devices: string[]; via: AskVia } | null {
    const active = this.activeDevice(a.user_id);
    if (active === a.host_device) return 'host';
    const online = this.followers(a).filter((d) =>
      this.readyDevice(a.user_id, d),
    );
    if (online.length === 0) return null;
    if (active !== null && online.includes(active)) {
      return { devices: [active], via: 'active' };
    }
    return { devices: online, via: 'origin' };
  }

  private activeDevice(user: string): string | null {
    const now = this.env.now();
    let best: { device: string; idle: number } | null = null;
    for (const c of this.ready(user)) {
      const p = c.state.presence;
      if (!p || !p.focused || p.locked) continue;
      const idle = p.idleMs + (now - p.atMs);
      if (idle >= ACTIVE_IDLE_MS) continue;
      if (!best || idle < best.idle) best = { device: c.state.device, idle };
    }
    return best?.device ?? null;
  }

  private presence(r: Ready, msg: Of<'presence'>) {
    const s = r.conn.state();
    s.presence = {
      focused: msg.focused,
      locked: msg.locked,
      idleMs: msg.idle_ms,
      atMs: this.env.now(),
    };
    r.conn.save(s);
    r.state.presence = s.presence;
    // Open, not yet escalated questions follow you between their space's
    // host and followers; any other device you're at doesn't take them.
    const active = this.activeDevice(r.state.user);
    if (!active) return;
    for (const a of this.store.rows<AskRow>(
      'SELECT * FROM asks WHERE user_id = ? AND escalated = 0',
      r.state.user,
    )) {
      if (active !== a.host_device && !this.followers(a).includes(active)) {
        continue;
      }
      const shown = shownOn(a);
      if (active === a.host_device) {
        if (shown.length === 0) continue;
        this.dismiss(a, shown, 'moved');
        this.setShown(a.ask_id, [], a.via);
        continue;
      }
      if (shown.length === 1 && shown[0] === active) continue;
      this.dismiss(a, shown, 'moved');
      const to = this.readyDevice(a.user_id, active)!;
      this.showAsk(to.conn, a, 'moved');
      this.setShown(a.ask_id, [active], 'moved');
    }
  }

  /**
   * Unanswered for 20 s, or nowhere to show: every follower too (not every
   * device), and a push to those away from a screen.
   */
  private escalate(a: AskRow) {
    // Marked first: a follower it can't be shown to must not keep it due.
    this.store.run(
      `UPDATE asks SET escalated = 1, via = 'escalated' WHERE ask_id = ?`,
      a.ask_id,
    );
    const shown = shownOn(a);
    for (const d of this.followers(a)) {
      if (shown.includes(d)) continue;
      const to = this.readyDevice(a.user_id, d);
      if (to) {
        this.showAsk(to.conn, a, 'escalated');
        shown.push(d);
      }
    }
    this.store.run(
      'UPDATE asks SET shown_on = ? WHERE ask_id = ?',
      JSON.stringify(shown),
      a.ask_id,
    );
    this.pushAsk(a.ask_id);
  }

  private askResolved(r: Ready, askId: string) {
    const a = this.store.ask(askId);
    if (!a) return;
    if (a.user_id !== r.state.user || a.host_device !== r.state.device) {
      return this.error(r.conn, codes.NOT_YOURS, 'not a question of yours');
    }
    this.dismiss(a, shownOn(a), 'resolved');
    this.store.run('DELETE FROM asks WHERE ask_id = ?', askId);
  }

  private showAsk(conn: Conn, a: AskRow, via: AskVia) {
    this.send(conn, {
      type: 'ask',
      envelope: JSON.parse(a.envelope) as SignedEnvelope,
      via,
    });
  }

  private setShown(askId: string, devices: string[], via?: string | null) {
    this.store.run(
      'UPDATE asks SET shown_on = ?, via = COALESCE(?, via) WHERE ask_id = ?',
      JSON.stringify(devices),
      via ?? null,
      askId,
    );
  }

  private dismiss(a: AskRow, devices: string[], reason: DismissReason) {
    if (devices.length === 0) return;
    for (const c of this.ready(a.user_id)) {
      if (devices.includes(c.state.device)) {
        this.send(c.conn, { type: 'dismiss', ask_id: a.ask_id, reason });
      }
    }
  }

  // ── confirms ───────────────────────────────────────────────────────────

  /**
   * A host's signed confirm (`Domain::Confirm`): Claude via the cloud's
   * request waits on it for a person's yes. Shown on the host's live
   * delegates (protocol 6), pushed to those away from a screen; they answer
   * with a signed `confirm` request to the host.
   */
  private async confirm(r: Ready, envelope: SignedEnvelope) {
    let c: RemoteConfirm;
    try {
      c = peekConfirm(envelope.body);
    } catch (e) {
      if (!(e instanceof BadMessage)) throw e;
      return this.error(r.conn, e.code, e.message);
    }
    const me = r.state.device;
    const user = r.state.user;
    if (envelope.device_id !== me || c.host_device !== me) {
      return this.error(
        r.conn,
        codes.NOT_YOURS,
        'a confirm must come from its host',
      );
    }
    const dev = this.store.device(me);
    if (!dev || !hosts(infoOf(dev).kind)) {
      return this.error(r.conn, codes.INVALID, 'only a computer asks this');
    }
    const existing = this.store.confirm(c.confirm_id);
    if (existing) {
      if (existing.user_id !== user || existing.host_device !== me) {
        return this.error(r.conn, codes.NOT_YOURS, 'confirm_id taken');
      }
      return; // already open
    }
    const now = this.env.now();
    if (c.expires_at_ms <= now) {
      return this.error(r.conn, codes.INVALID, 'confirm already expired');
    }
    const open =
      this.store.num('SELECT COUNT(*) FROM confirms WHERE user_id = ?', user) ??
      0;
    if (open >= MAX_CONFIRMS_PER_USER) {
      return this.error(r.conn, codes.BUSY, 'too many open confirms');
    }
    if (!(await this.signedBySender(r, envelope, 'confirm'))) {
      return this.error(
        r.conn,
        codes.BAD_SIGNATURE,
        'confirm not signed by its host',
      );
    }
    if (!r.conn.open) return;
    const forward = forwardOf(envelope);
    // The host waits at most the request window (the request's ttl here).
    this.store.run(
      `INSERT INTO confirms (confirm_id, user_id, host_device, envelope,
         expires_at_ms, shown_on, pushed, created_ms)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?)`,
      c.confirm_id,
      user,
      me,
      JSON.stringify(forward),
      Math.min(c.expires_at_ms, now + REQUEST_WINDOW_MS),
      now,
    );
    const row = this.store.confirm(c.confirm_id)!;
    const shown: string[] = [];
    for (const d of this.confirmDelegates(row)) {
      const to = this.readyDevice(user, d);
      if (!to || protocolOf(to.state) < V6) continue;
      this.send(to.conn, { type: 'confirm', envelope: forward });
      shown.push(d);
    }
    this.setConfirmShown(row.confirm_id, shown);
    this.pushConfirm(row, c);
  }

  private confirmResolved(r: Ready, confirmId: string) {
    const c = this.store.confirm(confirmId);
    if (!c) return;
    if (c.user_id !== r.state.user || c.host_device !== r.state.device) {
      return this.error(r.conn, codes.NOT_YOURS, 'not a confirm of yours');
    }
    this.dropConfirm(c);
  }

  /** Where a confirm goes: the host's live delegates, never an `mcp` one. */
  private confirmDelegates(c: ConfirmRow): string[] {
    return this.delegatesOf(c.host_device).filter((d) => {
      const dev = d !== c.host_device ? this.store.device(d) : undefined;
      return !!dev && dev.user_id === c.user_id && infoOf(dev).kind !== 'mcp';
    });
  }

  /** The open confirms `device` is a delegate for, sent to it (protocol 6). */
  private showConfirms(user: string, device: string) {
    const to = this.readyDevice(user, device);
    if (!to || protocolOf(to.state) < V6) return;
    for (const c of this.store.rows<ConfirmRow>(
      `SELECT * FROM confirms WHERE user_id = ? AND expires_at_ms > ?
       ORDER BY created_ms`,
      user,
      this.env.now(),
    )) {
      if (!this.confirmDelegates(c).includes(device)) continue;
      this.send(to.conn, {
        type: 'confirm',
        envelope: JSON.parse(c.envelope) as SignedEnvelope,
      });
      const shown = confirmShown(c);
      if (!shown.includes(device)) {
        this.setConfirmShown(c.confirm_id, [...shown, device]);
      }
    }
  }

  /** Answered, lapsed or its host gone: dismissed where it showed, dropped. */
  private dropConfirm(c: ConfirmRow) {
    // Dropped first: a device it can't be dismissed on must not keep it.
    this.store.run('DELETE FROM confirms WHERE confirm_id = ?', c.confirm_id);
    this.dismissConfirm(c.user_id, c.confirm_id, [
      ...confirmShown(c),
      ...this.confirmDelegates(c),
    ]);
  }

  /** `confirm_dismissed` to those of `devices` online on protocol 6. */
  private dismissConfirm(user: string, confirmId: string, devices: string[]) {
    if (devices.length === 0) return;
    for (const c of this.ready(user)) {
      if (!devices.includes(c.state.device) || protocolOf(c.state) < V6) {
        continue;
      }
      this.send(c.conn, { type: 'confirm_dismissed', confirm_id: confirmId });
    }
  }

  private setConfirmShown(confirmId: string, devices: string[]) {
    this.store.run(
      'UPDATE confirms SET shown_on = ? WHERE confirm_id = ?',
      JSON.stringify(devices),
      confirmId,
    );
  }

  /**
   * A new confirm, pushed once to each of the host's delegates away from a
   * screen (not one online on an older protocol: it couldn't answer).
   */
  private pushConfirm(row: ConfirmRow, c: RemoteConfirm) {
    const pushed = JSON.parse(row.pushed) as string[];
    const to = this.confirmDelegates(row).filter((d) => {
      if (pushed.includes(d) || this.attending(row.user_id, d)) return false;
      const live = this.readyDevice(row.user_id, d);
      return !live || protocolOf(live.state) >= V6;
    });
    if (to.length === 0) return;
    const host = this.store.device(row.host_device);
    const hostName = host ? infoOf(host).name : 'Theodore';
    const sent = this.sendPushes(row.user_id, to, () =>
      confirmPush(hostName, c),
    );
    if (sent.length === 0) return;
    this.store.run(
      'UPDATE confirms SET pushed = ? WHERE confirm_id = ?',
      JSON.stringify([...pushed, ...sent]),
      row.confirm_id,
    );
  }

  // ── devices and storage ────────────────────────────────────────────────

  /**
   * Forget one of the user's other devices: its row, the spaces it hosts
   * (events, questions), requests waiting for it. Only an offline one, so
   * one device (say a compromised one) can't knock the others out. A key
   * that connects again registers as a new device.
   */
  private removeDevice(r: Ready, deviceId: string) {
    const user = r.state.user;
    const dev = this.store.device(deviceId);
    if (!dev || dev.user_id !== user) {
      return this.error(r.conn, codes.NOT_YOURS, 'no such device');
    }
    if (deviceId === r.state.device) {
      return this.error(r.conn, codes.INVALID, 'a device can’t remove itself');
    }
    if (this.readyDevice(user, deviceId)) {
      return this.error(
        r.conn,
        codes.INVALID,
        'only an offline device can be removed',
      );
    }
    this.store.run('DELETE FROM devices WHERE device_id = ?', deviceId);
    for (const c of this.store.rows<ConfirmRow>(
      'SELECT * FROM confirms WHERE host_device = ?',
      deviceId,
    )) {
      this.dropConfirm(c);
    }
    this.forgetSpaces(
      this.store
        .rows<{
          space: string;
        }>('SELECT space FROM spaces WHERE host_device = ?', deviceId)
        .map((x) => x.space),
    );
    for (const p of this.store.rows<PendingRow>(
      'SELECT * FROM pending WHERE target_device = ?',
      deviceId,
    )) {
      this.store.run('DELETE FROM pending WHERE req_id = ?', p.req_id);
      this.deliver(p.user_id, p.origin_device, p.req_id, {
        type: 'refused',
        req_id: p.req_id,
        code: codes.OFFLINE,
        message: 'the device was removed',
      });
    }
    this.store.run('DELETE FROM replies WHERE origin_device = ?', deviceId);
    this.store.run('DELETE FROM subs WHERE device_id = ?', deviceId);
    this.store.run('DELETE FROM push_tokens WHERE device_id = ?', deviceId);
    const named = this.store.rows<DelegationRow>(
      `SELECT * FROM delegations
       WHERE origin_device = ? OR delegate_device = ?`,
      deviceId,
      deviceId,
    );
    for (const d of named) this.endDelegation(d);
    this.pushDevices(user);
    this.pushDelegations(
      user,
      named.flatMap((d) => [d.origin_device, d.delegate_device]),
    );
  }

  // ── push and delegations ───────────────────────────────────────────────

  /** A phone's Expo token: stored, replaced, or ('' ) removed. */
  private registerPush(r: Ready, msg: Of<'register_push'>) {
    const dev = this.store.device(r.state.device);
    if (!dev || infoOf(dev).kind !== 'mobile') {
      return this.error(r.conn, codes.INVALID, 'push is for the phone app');
    }
    if (msg.token === '') {
      this.store.run(
        'DELETE FROM push_tokens WHERE device_id = ?',
        r.state.device,
      );
      return;
    }
    // One phone, one row: a token another device (an old install, another
    // account) still holds would push this phone someone else's questions.
    this.store.run(
      'DELETE FROM push_tokens WHERE token = ? AND device_id != ?',
      msg.token,
      r.state.device,
    );
    this.store.run(
      `INSERT INTO push_tokens (device_id, user_id, provider, token)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (device_id) DO UPDATE SET
         provider = excluded.provider, token = excluded.token`,
      r.state.device,
      r.state.user,
      msg.provider,
      msg.token,
    );
  }

  /**
   * An origin's signed delegation (`Domain::Delegate`): checked against the
   * sender's pinned key, stored as signed, then the live list goes to both
   * devices. A revocation stays as a tombstone until no older grant could
   * still pass the freshness check.
   */
  private async delegate(r: Ready, envelope: SignedEnvelope) {
    let d: Delegation;
    try {
      d = peekDelegation(envelope.body);
    } catch (e) {
      if (!(e instanceof BadMessage)) throw e;
      return this.error(r.conn, e.code, e.message);
    }
    const me = r.state.device;
    const user = r.state.user;
    if (envelope.device_id !== me || d.origin_device !== me) {
      return this.error(
        r.conn,
        codes.NOT_YOURS,
        'a delegation must come from its origin',
      );
    }
    if (d.delegate_device === me) {
      return this.error(r.conn, codes.INVALID, 'a device can’t follow itself');
    }
    const to = this.store.device(d.delegate_device);
    if (!to || to.user_id !== user) {
      return this.error(r.conn, codes.NOT_YOURS, 'no such device');
    }
    const now = this.env.now();
    if (Math.abs(d.issued_at_ms - now) > REQUEST_WINDOW_MS) {
      return this.error(r.conn, codes.STALE_REQUEST, 'delegation not fresh');
    }
    if (!d.revoke && d.expires_at_ms !== 0 && d.expires_at_ms <= now) {
      return this.error(r.conn, codes.INVALID, 'delegation already expired');
    }
    const prev = this.store.one<DelegationRow>(
      `SELECT * FROM delegations
       WHERE origin_device = ? AND delegate_device = ?`,
      me,
      d.delegate_device,
    );
    if (prev && d.issued_at_ms < prev.issued_at_ms) {
      return this.error(
        r.conn,
        codes.STALE_REQUEST,
        'older than the delegation kept',
      );
    }
    if (!(await this.signedBySender(r, envelope, 'delegate'))) {
      return this.error(
        r.conn,
        codes.BAD_SIGNATURE,
        'delegation not signed by its origin',
      );
    }
    if (!r.conn.open) return;
    this.store.run(
      `INSERT OR REPLACE INTO delegations (origin_device, delegate_device,
         user_id, envelope, issued_at_ms, expires_at_ms, revoked)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      me,
      d.delegate_device,
      user,
      JSON.stringify(forwardOf(envelope)),
      d.issued_at_ms,
      d.expires_at_ms,
      d.revoke ? 1 : 0,
    );
    if (d.revoke) this.unfollow(user, me, d.delegate_device);
    this.pushDelegations(user, [me, d.delegate_device]);
    if (!d.revoke) this.showConfirms(user, d.delegate_device);
  }

  /** Expired grants go (both devices told); old tombstones are dropped. */
  private pruneDelegations(now: number) {
    const expired = this.store.rows<DelegationRow>(
      `SELECT * FROM delegations
       WHERE revoked = 0 AND expires_at_ms > 0 AND expires_at_ms <= ?`,
      now,
    );
    for (const d of expired) {
      this.attempt('end expired delegation', () => {
        this.endDelegation(d);
        this.pushDelegations(d.user_id, [d.origin_device, d.delegate_device]);
      });
    }
    this.store.run(
      'DELETE FROM delegations WHERE revoked = 1 AND issued_at_ms < ?',
      now - REQUEST_WINDOW_MS,
    );
  }

  /** A delegation's row deleted and its delegate's following undone. */
  private endDelegation(d: DelegationRow) {
    this.store.run(
      `DELETE FROM delegations
       WHERE origin_device = ? AND delegate_device = ?`,
      d.origin_device,
      d.delegate_device,
    );
    this.unfollow(d.user_id, d.origin_device, d.delegate_device);
  }

  /**
   * `delegate` no longer follows `origin`'s spaces: its subscriptions to
   * them end and the questions it shows are dismissed there.
   */
  private unfollow(user: string, origin: string, delegate: string) {
    this.store.run(
      `DELETE FROM subs WHERE device_id = ? AND space IN
         (SELECT space FROM spaces
          WHERE origin_device = ? AND host_device != ?)`,
      delegate,
      origin,
      delegate,
    );
    for (const a of this.store.rows<AskRow>(
      'SELECT * FROM asks WHERE user_id = ? AND origin_device = ?',
      user,
      origin,
    )) {
      const shown = shownOn(a);
      if (!shown.includes(delegate) || a.host_device === delegate) continue;
      this.dismiss(a, [delegate], 'resolved');
      this.setShown(
        a.ask_id,
        shown.filter((x) => x !== delegate),
      );
    }
    // The origin's confirms, if it is a host: no longer the delegate's.
    for (const c of this.store.rows<ConfirmRow>(
      'SELECT * FROM confirms WHERE user_id = ? AND host_device = ?',
      user,
      origin,
    )) {
      const shown = confirmShown(c);
      if (!shown.includes(delegate)) continue;
      this.dismissConfirm(user, c.confirm_id, [delegate]);
      this.setConfirmShown(
        c.confirm_id,
        shown.filter((x) => x !== delegate),
      );
    }
  }

  /** Live delegations of `origin`: the devices following its spaces. */
  private delegatesOf(origin: string): string[] {
    return this.store
      .rows<{ delegate_device: string }>(
        `SELECT delegate_device FROM delegations
         WHERE origin_device = ? AND revoked = 0
           AND (expires_at_ms = 0 OR expires_at_ms > ?)
         ORDER BY delegate_device`,
        origin,
        this.env.now(),
      )
      .map((x) => x.delegate_device);
  }

  /** A space's followers: its origin and the origin's delegates, not its host. */
  private followers(sp: { origin_device: string; host_device: string }) {
    return [sp.origin_device, ...this.delegatesOf(sp.origin_device)].filter(
      (d) => d !== sp.host_device,
    );
  }

  /** The live delegations naming `device`, as their origins signed them. */
  private delegationsNaming(device: string): SignedEnvelope[] {
    return this.store
      .rows<{ envelope: string }>(
        `SELECT envelope FROM delegations
         WHERE (origin_device = ? OR delegate_device = ?) AND revoked = 0
           AND (expires_at_ms = 0 OR expires_at_ms > ?)
         ORDER BY origin_device, delegate_device`,
        device,
        device,
        this.env.now(),
      )
      .map((x) => JSON.parse(x.envelope) as SignedEnvelope);
  }

  /** `delegations{list}` to those of `devices` online on protocol 4. */
  private pushDelegations(user: string, devices: string[]) {
    const to = new Set(devices);
    for (const c of this.ready(user)) {
      if (!to.has(c.state.device) || protocolOf(c.state) < V4) continue;
      this.send(c.conn, {
        type: 'delegations',
        list: this.delegationsNaming(c.state.device),
      });
    }
  }

  /** You're looking at it: connected, focused and unlocked. */
  private attending(user: string, device: string): boolean {
    const p = this.readyDevice(user, device)?.state.presence;
    return !!p && p.focused && !p.locked;
  }

  /** An open question, pushed once to each follower away from a screen. */
  private pushAsk(askId: string) {
    const a = this.store.ask(askId);
    const sp = a && this.store.space(a.space);
    if (!a || !sp) return;
    const pushed = JSON.parse(a.pushed) as string[];
    const to = this.followers(a).filter(
      (d) => !pushed.includes(d) && !this.attending(a.user_id, d),
    );
    if (to.length === 0) return;
    // The host's signed question set, verified when it came in.
    const ask = JSON.parse(
      (JSON.parse(a.envelope) as SignedEnvelope).body,
    ) as RemoteAsk;
    const { title } = this.pushTitle(sp);
    const sent = this.sendPushes(a.user_id, to, () => askPush(title, ask));
    if (sent.length === 0) return;
    this.store.run(
      'UPDATE asks SET pushed = ? WHERE ask_id = ?',
      JSON.stringify([...pushed, ...sent]),
      a.ask_id,
    );
  }

  /** A space that turned idle, failed or stopped: one push per follower. */
  private pushFinished(sp: SpaceRow, status: string) {
    const to = this.followers(sp).filter((d) => !this.attending(sp.user_id, d));
    if (to.length === 0) return;
    const { title, space } = this.pushTitle(sp);
    const word = status === 'idle' ? 'finished' : status;
    this.sendPushes(sp.user_id, to, () => ({
      title,
      body: clip(`${space} ${word}`, PUSH_BODY_CHARS),
      channelId: 'default',
      data: {
        kind: 'finished',
        ask_id: '',
        space: sp.space,
        host_device: sp.host_device,
        options: [],
        status,
      },
    }));
  }

  /**
   * "<host> · <space>" from what the cloud holds: the host's name from its
   * own hello, the space's from its host-signed `started` event (else its id).
   */
  private pushTitle(sp: SpaceRow): { title: string; space: string } {
    const host = this.store.device(sp.host_device);
    const hostName = host ? infoOf(host).name : 'Theodore';
    let space = sp.space;
    try {
      const body = JSON.parse(
        (JSON.parse(sp.started ?? 'null') as SignedEnvelope | null)?.body ??
          'null',
      ) as SpaceEventBody | null;
      if (
        body?.event.kind === 'started' &&
        typeof body.event.name === 'string' &&
        body.event.name !== ''
      ) {
        space = body.event.name;
      }
    } catch {
      // a malformed started body: the id stands in
    }
    return {
      title: clip(`${hostName} · ${space}`, 120),
      space: clip(space, 100),
    };
  }

  /**
   * Builds one push per device of `devices` that has a token and room in
   * its minute (30), sends them in the background, and drops tokens Expo
   * says are gone. Returns the devices pushed.
   */
  private sendPushes(
    user: string,
    devices: string[],
    build: () => Omit<PushMessage, 'to'>,
  ): string[] {
    const push = this.env.push;
    if (!push) return [];
    const now = this.env.now();
    const msgs: PushMessage[] = [];
    const sent: string[] = [];
    for (const d of devices) {
      const t = this.store.one<PushTokenRow>(
        'SELECT * FROM push_tokens WHERE device_id = ? AND user_id = ?',
        d,
        user,
      );
      if (!t) continue;
      const fresh = now - t.window_ms >= 60_000;
      const count = fresh ? 0 : t.sent;
      if (count >= PUSH_PER_MINUTE) continue;
      this.store.run(
        'UPDATE push_tokens SET window_ms = ?, sent = ? WHERE device_id = ?',
        fresh ? now : t.window_ms,
        count + 1,
        d,
      );
      msgs.push({ to: t.token, ...build() });
      sent.push(d);
    }
    if (msgs.length === 0) return sent;
    const work = push(msgs).then((results) => {
      const dead = msgs
        .filter((_, i) => results[i] === 'unregistered')
        .map((m) => m.to);
      this.log.info('push sent', {
        provider: 'expo',
        kind: msgs[0]?.data.kind,
        user_id: user,
        sent: msgs.length,
        ok: results.filter((r) => r === 'ok').length,
        unregistered: dead.length,
        failed: results.filter((r) => r === 'failed').length,
      });
      if (dead.length === 0) return;
      return this.run(() => {
        for (const token of dead) {
          this.store.run('DELETE FROM push_tokens WHERE token = ?', token);
        }
      });
    });
    if (this.env.defer) this.env.defer(work);
    else void work;
    return sent;
  }

  /** Spaces gone for good: their questions are dismissed, then dropped. */
  private forgetSpaces(spaces: string[]) {
    for (const sp of spaces) {
      for (const a of this.store.rows<AskRow>(
        'SELECT * FROM asks WHERE space = ?',
        sp,
      )) {
        this.dismiss(a, shownOn(a), 'resolved');
      }
      this.store.run('DELETE FROM asks WHERE space = ?', sp);
    }
    this.store.dropSpaces(spaces);
  }

  /** Spaces whose host is gone or has been offline for 30 days. */
  private pruneStale(now: number) {
    const online = new Set(this.ready().map((c) => c.state.device));
    this.forgetSpaces(
      this.store
        .rows<{ space: string; host_device: string }>(
          `SELECT s.space, s.host_device FROM spaces s
           LEFT JOIN devices d ON d.device_id = s.host_device
           WHERE d.device_id IS NULL OR d.last_seen_ms < ?`,
          now - HOST_OFFLINE_PRUNE_MS,
        )
        .filter((x) => !online.has(x.host_device))
        .map((x) => x.space),
    );
  }

  /** Whether `env` is signed for `domain` by the sending device's pinned key. */
  private async signedBySender(
    r: Ready,
    env: SignedEnvelope,
    domain: Domain,
  ): Promise<boolean> {
    const dev = this.store.device(r.state.device);
    return !!dev && (await verifyEnvelope(dev.public_key, env, domain));
  }

  // ── plumbing ───────────────────────────────────────────────────────────

  private run(fn: () => void | Promise<void>): Promise<void> {
    const next = this.chain
      .then(fn)
      .catch((e: unknown) => {
        // The error only: a message may carry a token or a signed body.
        this.log.exception('fleet internal error', e, {
          code: codes.INTERNAL,
        });
      })
      .then(() => this.reschedule())
      .catch(() => {});
    this.chain = next;
    return next;
  }

  /** `run`, but a failure reaches the caller (after it is logged). */
  private async runOrThrow(fn: () => void): Promise<void> {
    let failed: { e: unknown } | undefined;
    await this.run(() => {
      try {
        fn();
      } catch (e) {
        failed = { e };
        throw e;
      }
    });
    if (failed) throw failed.e;
  }

  private async reschedule() {
    const due = this.dueTerms().map((t) => t.at);
    let at = due.length ? Math.min(...due) : null;
    // After an alarm that left a row due (logged there): not before its retry.
    if (at !== null && this.alarmRetryAt !== null && at < this.alarmRetryAt) {
      at = this.alarmRetryAt;
    }
    await this.env.schedule(at);
  }

  /**
   * When each table next needs the alarm (unix ms), those that do. Each
   * term is exactly what `alarm` clears at that time: a term that stays
   * due after an alarm is a bug there, not a reason to wake again.
   */
  private dueTerms(): { term: string; at: number }[] {
    const s = this.store;
    const terms: [string, number | null, number][] = [
      ['conns', s.num('SELECT MIN(deadline_ms) FROM conns'), 0],
      [
        'pending_grace',
        s.num('SELECT MIN(grace_until) FROM pending WHERE claimed = 0'),
        0,
      ],
      ['pending_ttl', s.num('SELECT MIN(created_ms + ttl_ms) FROM pending'), 0],
      ['replies', s.num('SELECT MIN(created_ms) FROM replies'), PENDING_TTL_MS],
      [
        'asks',
        s.num('SELECT MIN(created_ms) FROM asks WHERE escalated = 0'),
        ESCALATE_MS,
      ],
      [
        'delegations',
        s.num(
          `SELECT MIN(expires_at_ms) FROM delegations
           WHERE revoked = 0 AND expires_at_ms > 0`,
        ),
        0,
      ],
      ['confirms', s.num('SELECT MIN(expires_at_ms) FROM confirms'), 0],
      ['gone_users', s.num('SELECT MIN(until_ms) FROM gone_users'), 0],
    ];
    return terms.flatMap(([term, v, ttl]) =>
      v === null ? [] : [{ term, at: v + ttl }],
    );
  }

  /** Token bucket; over it, the frame is dropped with one error a second. */
  private allow(conn: Conn, id: string): boolean {
    const now = this.env.now();
    const b = this.buckets.get(id) ?? {
      tokens: RATE_BURST,
      at: now,
      warned: 0,
    };
    b.tokens = Math.min(
      RATE_BURST,
      b.tokens + ((now - b.at) / 1000) * RATE_PER_SECOND,
    );
    b.at = now;
    this.buckets.set(id, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    if (now - b.warned >= 1000) {
      b.warned = now;
      this.log.info('rate limited', {
        bucket: 'fleet',
        ...this.connAttrs(stateOf(conn)),
      });
      void this.run(() =>
        this.error(conn, codes.RATE_LIMITED, 'too many messages'),
      );
    }
    return false;
  }

  /** The connection's device, if it is still the device's current one. */
  private asReady(conn: Conn, s: ConnState): Ready | null {
    const dev = this.store.device(s.device);
    if (!dev || s.device === undefined || dev.generation !== s.generation) {
      s.phase = 'closed';
      conn.save(s);
      conn.close(close.REPLACED, 'replaced by a newer connection');
      return null;
    }
    return { conn, state: s as Ready['state'] };
  }

  /** Connections past hello: one user's, or all with no user. */
  private ready(user?: string, except?: string): Ready[] {
    const out: Ready[] = [];
    for (const conn of this.env.conns(user)) {
      if (!conn.open) continue;
      const state = stateOf(conn);
      if (state?.phase !== 'ready' || state.id === except) continue;
      out.push({ conn, state: state as Ready['state'] });
    }
    return out;
  }

  private readyDevice(user: string, device: string): Ready | undefined {
    return this.ready(user).find((c) => c.state.device === device);
  }

  private pushDevices(user: string, except?: string) {
    const conns = this.ready(user, except);
    const online = new Set(conns.map((c) => c.state.device));
    const devices = this.listDevices(user).map((d) => ({
      ...d,
      online: online.has(d.device_id),
    }));
    // A connection sees only the kinds its protocol can read: protocol 3
    // computers only (and no OS past `macos` / `linux`: a Windows computer
    // reads as Linux), protocol 4 no `mcp`.
    const seen = (p: number) =>
      devices
        .filter((d) => protocolToSee(d.info.kind) <= p)
        .map((d) =>
          p >= V4 || d.info.os === 'macos' || d.info.os === 'linux'
            ? d
            : { ...d, info: { ...d.info, os: 'linux' as const } },
        );
    const byProtocol = new Map<number, DeviceSummary[]>();
    for (const c of conns) {
      const p = protocolOf(c.state);
      let list = byProtocol.get(p);
      if (!list) {
        list = seen(p);
        byProtocol.set(p, list);
      }
      this.send(c.conn, { type: 'devices', devices: list });
    }
  }

  private send(conn: Conn, msg: ServerMessage) {
    try {
      conn.send(JSON.stringify(msg));
    } catch {
      // closed under us; its close handler cleans up
    }
  }

  private error(conn: Conn, code: string, message: string) {
    if (QUOTA_CODES.has(code)) {
      this.log.info('quota hit', { code, ...this.connAttrs(stateOf(conn)) });
    }
    this.send(conn, { type: 'error', code, message });
  }

  /** Error, then close with the code as the reason: the connection is done. */
  private fail(conn: Conn, code: string, message: string) {
    const closeCode = closeCodeFor(code);
    this.error(conn, code, message);
    const s = conn.state();
    const wasReady = s.phase === 'ready';
    this.log.info('fleet disconnected', {
      ...this.connAttrs(s),
      by: 'cloud',
      code,
      close_code: closeCode,
    });
    s.phase = 'closed';
    conn.save(s);
    try {
      conn.close(closeCode, code);
    } catch {
      // already closing
    }
    if (wasReady) this.gone(s);
  }
}

/**
 * Whether `verify` refused the token itself (a bad signature, an expired or
 * foreign token: `cloud.unauthorized`), rather than failing to check it
 * (`cloud.jwks_unavailable`, or anything unexpected).
 */
function badToken(e: unknown): boolean {
  return e instanceof CloudError && e.code === 'cloud.unauthorized';
}

/** Why a target too old for `op` is refused (static words). */
function upgradeWords(op: string): string {
  if (archives(op)) {
    return 'that computer runs an older Theodore: update it to archive its spaces from another device';
  }
  return onAnySpace(op)
    ? 'that computer runs an older Theodore: update it to reach all its spaces'
    : 'that computer runs an older Theodore: update it to take approvals and auto mode from another device';
}

/** A `mirror` model the cloud keeps (the latest per id), not just relays. */
function isKept(model: string): boolean {
  return (MIRROR_KEPT as readonly string[]).includes(model);
}

/** A connection's protocol: 3 for attachments saved before v4. */
function protocolOf(s: ConnState): number {
  return s.protocol ?? 3;
}

/** A device's stored info (checked by `wire.ts` when it came in). */
function infoOf(d: DeviceRow): DeviceInfo {
  return JSON.parse(d.info) as DeviceInfo;
}

/**
 * The push for a question (docs/mobile.md, mobile/src/push/README.md): one
 * single-choice or free-text question gets the body and category the app
 * registered buttons for; several questions or multi-select get no
 * category (answered in the app) and no options.
 */
function askPush(title: string, ask: RemoteAsk): Omit<PushMessage, 'to'> {
  const q = ask.questions[0];
  const single = ask.questions.length === 1 && q !== undefined && !q.multi;
  const shown = single
    ? askPresentation(q.question, q.options)
    : { body: clip(q?.question ?? 'A question', PUSH_BODY_CHARS) };
  return {
    title,
    ...shown,
    channelId: 'default',
    priority: 'high',
    data: {
      kind: 'ask',
      ask_id: ask.ask_id,
      space: ask.space,
      host_device: ask.host_device,
      options: single ? q.options.slice(0, PUSH_ACTIONS) : [],
    },
  };
}

/** A socket's state; none before `open` saved it (a fresh DO socket). */
function stateOf(conn: Conn): ConnState | null {
  return (conn.state() as ConnState | null | undefined) ?? null;
}

/** An envelope as received: its three fields, the body's bytes untouched. */
function forwardOf(env: SignedEnvelope): SignedEnvelope {
  return {
    device_id: env.device_id,
    body: env.body,
    signature: env.signature,
  };
}

function shownOn(a: AskRow): string[] {
  return JSON.parse(a.shown_on) as string[];
}

function confirmShown(c: ConfirmRow): string[] {
  return JSON.parse(c.shown_on) as string[];
}
