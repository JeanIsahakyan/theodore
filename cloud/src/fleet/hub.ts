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
 *   ─▶ space_event (host-signed) ─▶ ring 500 / 4 MB ─▶ subscribers
 *   ─▶ ask (host-signed) ─▶ active if origin/host │ origin; 20 s ─▶ origin
 * ```
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
  DeviceInfo,
  DeviceSummary,
  DismissReason,
  RemoteAsk,
  ServerMessage,
  SignedEnvelope,
  SpaceEventBody,
} from '../gen/fleet';
import { CloudError } from '../errors';
import {
  ACTIVE_IDLE_MS,
  close,
  closeCodeFor,
  codes,
  ESCALATE_MS,
  GRACE_MS,
  HELLO_TIMEOUT_MS,
  HOST_OFFLINE_PRUNE_MS,
  MAX_ASKS_PER_SPACE,
  MAX_ASKS_PER_USER,
  MAX_CHILDREN,
  MAX_CONNS_PER_USER,
  MAX_DEPTH,
  MAX_DEVICES_PER_USER,
  MAX_FRAME_BYTES,
  MAX_PENDING_PER_USER,
  MAX_SPACES_PER_USER,
  MAX_USER_EVENT_BYTES,
  NONCE_BYTES,
  PENDING_TTL_MS,
  RATE_BURST,
  RATE_PER_SECOND,
  REAUTH_LEEWAY_MS,
} from './limits';
import {
  Store,
  type AskRow,
  type DeviceRow,
  type PendingRow,
  type Sql,
} from './store';
import {
  type Domain,
  type ReplyRouting,
  type Routing,
  b64,
  BadMessage,
  byteLength,
  parseClient,
  peekAsk,
  peekEvent,
  peekReply,
  peekRequest,
  unb64,
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
}

interface Ready {
  conn: Conn;
  state: ConnState & { device: string; generation: number };
}

type Of<T extends ClientMessage['type']> = Extract<ClientMessage, { type: T }>;

export class Hub {
  readonly store: Store;
  private chain: Promise<void> = Promise.resolve();
  private buckets = new Map<
    string,
    { tokens: number; at: number; warned: number }
  >();

  constructor(private env: HubEnv) {
    this.store = new Store(env.sql);
  }

  // ── entry points ───────────────────────────────────────────────────────

  open(conn: Conn, caller: FleetCaller): Promise<void> {
    return this.run(() => {
      // One challenge per connection: a device signs one nonce per socket.
      if (stateOf(conn)) return;
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
    if (!this.allow(conn)) return Promise.resolve();
    return this.run(async () => {
      if (!conn.open) return;
      const s = conn.state();
      if (s.phase === 'closed') return;
      if (typeof data !== 'string') {
        return this.error(conn, codes.BAD_MESSAGE, 'text frames only');
      }
      let msg;
      try {
        msg = parseClient(data);
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
      }
    });
  }

  closed(conn: Conn): Promise<void> {
    return this.run(() => {
      const s = conn.state();
      this.buckets.delete(s.id);
      this.store.run('DELETE FROM conns WHERE conn_id = ?', s.id);
      // `closed`: replaced, or failed (cleaned up then).
      if (s.phase === 'ready') this.gone(s);
    });
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

  alarm(): Promise<void> {
    return this.run(() => {
      const now = this.env.now();
      for (const row of this.store.rows<{ conn_id: string; user_id: string }>(
        'SELECT conn_id, user_id FROM conns WHERE deadline_ms <= ?',
        now,
      )) {
        this.store.run('DELETE FROM conns WHERE conn_id = ?', row.conn_id);
        const conn = this.env
          .conns(row.user_id)
          .find((c) => c.open && c.state().id === row.conn_id);
        if (!conn) continue;
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
      for (const p of this.store.rows<PendingRow>(
        `SELECT * FROM pending
         WHERE (claimed = 0 AND grace_until <= ?) OR created_ms <= ?`,
        now,
        now - PENDING_TTL_MS,
      )) {
        this.store.run('DELETE FROM pending WHERE req_id = ?', p.req_id);
        this.deliver(p.user_id, p.origin_device, p.req_id, {
          type: 'refused',
          req_id: p.req_id,
          code: codes.OFFLINE,
          message: 'the device did not answer in time',
        });
      }
      this.store.run(
        'DELETE FROM replies WHERE created_ms <= ?',
        now - PENDING_TTL_MS,
      );
      for (const a of this.store.rows<AskRow>(
        'SELECT * FROM asks WHERE escalated = 0 AND created_ms <= ?',
        now - ESCALATE_MS,
      )) {
        this.escalate(a);
      }
      this.pruneStale(now);
    });
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
    conn.save(s);
    this.store.setDeadline(s.id, s.user, s.expMs + REAUTH_LEEWAY_MS);
    this.store.run('DELETE FROM subs WHERE device_id = ?', deviceId);

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
    // Open questions it was showing, or escalated ones of spaces it started.
    for (const a of this.store.rows<AskRow>(
      'SELECT * FROM asks WHERE user_id = ? ORDER BY created_ms',
      s.user,
    )) {
      if (a.host_device === deviceId) continue;
      const shown = shownOn(a);
      if (shown.includes(deviceId)) {
        this.showAsk(conn, a, (a.via ?? 'escalated') as AskVia);
      } else if (a.escalated && a.origin_device === deviceId) {
        this.showAsk(conn, a, 'escalated');
        this.setShown(a.ask_id, [...shown, deviceId]);
      }
    }
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
    const { envelope } = msg;
    let parsed: Routing;
    try {
      parsed = peekRequest(envelope.body);
    } catch (e) {
      if (!(e instanceof BadMessage)) throw e;
      return this.error(r.conn, e.code, e.message);
    }
    const route = parsed;
    const user = r.state.user;
    const refuse = (code: string, message: string) =>
      this.send(r.conn, {
        type: 'refused',
        req_id: route.req_id,
        code,
        message,
      });
    if (
      envelope.device_id !== r.state.device ||
      route.origin_device !== r.state.device
    ) {
      return refuse(codes.NOT_YOURS, 'a request must come from its origin');
    }
    if (route.target_device === route.origin_device) {
      return refuse(codes.INVALID, 'a device can’t send a request to itself');
    }
    const target = this.store.device(route.target_device);
    if (!target || target.user_id !== user) {
      return refuse(codes.NOT_YOURS, 'no such device');
    }
    // The target checks this too: a key the cloud doesn't pin for that id
    // was signed for another machine.
    if (route.target_key !== target.public_key) {
      return refuse(codes.NOT_YOURS, 'not that device’s key');
    }
    const existing = this.store.pending(route.req_id);
    if (existing) {
      return this.error(r.conn, codes.BAD_MESSAGE, 'req_id already pending');
    }
    const open =
      this.store.num(
        'SELECT COUNT(*) AS n FROM pending WHERE user_id = ?',
        user,
      ) ?? 0;
    if (open >= MAX_PENDING_PER_USER) {
      return refuse(codes.BUSY, 'too many requests in flight');
    }
    const space = this.store.space(route.space);
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
         parent, depth, ask_id)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    );
    if (to) {
      this.send(to.conn, {
        type: 'request',
        envelope: forward,
        generation: target.generation,
      });
    }
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
    const gap =
      body.seq > sp.last_seq + 1
        ? { from: sp.last_seq + 1, to: body.seq - 1 }
        : null;
    const ev = body.event;
    const bytes = new TextEncoder().encode(envelope.body).byteLength;
    const started = ev.kind === 'started';
    // The space's ring makes room by itself; the user's budget by the
    // oldest events of finished spaces, else the event stays in the host's
    // journal (it resumes from `last_seq`).
    const ring = this.store.ringTrim(sp.space, bytes);
    const need = bytes - ring.freed + (started ? bytes - sp.started_bytes : 0);
    let over = this.store.userBytes(sp.user_id) + need - MAX_USER_EVENT_BYTES;
    if (over > 0) over -= this.store.dropFinished(sp.user_id, sp.space, over);
    if (over > 0) {
      return this.error(r.conn, codes.BUSY, 'event storage full');
    }
    this.store.addEvent(sp.space, body.seq, text, bytes, ring.upTo);
    this.store.run(
      `UPDATE spaces SET last_seq = ?, last_ms = ?,
         status = COALESCE(?, status),
         started = COALESCE(?, started),
         started_seq = COALESCE(?, started_seq),
         started_bytes = COALESCE(?, started_bytes)
       WHERE space = ?`,
      body.seq,
      this.env.now(),
      ev.kind === 'status' ? ev.status : null,
      started ? text : null,
      started ? body.seq : null,
      started ? bytes : null,
      sp.space,
    );
    this.fanOut(sp.user_id, sp.space, gap, forward);
  }

  private fanOut(
    user: string,
    space: string,
    gap: { from: number; to: number } | null,
    envelope: SignedEnvelope,
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
      this.send(c.conn, { type: 'space_event', envelope });
    }
  }

  /** History then live, for the space's origin and its host only. */
  private subscribe(r: Ready, msg: Of<'subscribe'>) {
    const sp = this.store.space(msg.space);
    const d = r.state.device;
    if (
      !sp ||
      sp.user_id !== r.state.user ||
      (d !== sp.origin_device && d !== sp.host_device)
    ) {
      return this.error(r.conn, codes.NOT_YOURS, 'no such space');
    }
    this.store.run(
      'INSERT OR IGNORE INTO subs (device_id, space) VALUES (?, ?)',
      d,
      sp.space,
    );
    if (msg.since >= sp.last_seq) return;
    const gap = (from: number, to: number) =>
      this.send(r.conn, { type: 'space_gap', space: sp.space, from, to });
    const ev = (text: string) =>
      this.send(r.conn, {
        type: 'space_event',
        envelope: JSON.parse(text) as SignedEnvelope,
      });
    // `next`: the first seq not sent yet; a jump past it is a gap.
    let next = msg.since + 1;
    const first =
      this.store.num('SELECT MIN(seq) FROM events WHERE space = ?', sp.space) ??
      sp.last_seq + 1;
    const s = sp.started_seq;
    // Older than the ring: the started event (kept apart) still goes.
    if (sp.started && s !== null && s >= next && s < first) {
      if (s > next) gap(next, s - 1);
      ev(sp.started);
      next = s + 1;
    }
    for (const e of this.store.rows<{ seq: number; envelope: string }>(
      'SELECT seq, envelope FROM events WHERE space = ? AND seq > ? ORDER BY seq',
      sp.space,
      msg.since,
    )) {
      if (e.seq > next) gap(next, e.seq - 1);
      ev(e.envelope);
      next = e.seq + 1;
    }
    if (next <= sp.last_seq) gap(next, sp.last_seq);
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
    const to = this.readyDevice(row.user_id, where.device)!;
    this.showAsk(to.conn, row, where.via);
    this.setShown(row.ask_id, [where.device], where.via);
  }

  /**
   * Only the space's host and origin see its questions: the host when it is
   * your active device (it shows its own card), else the origin if online
   * (`active` when you're at it), else nobody yet (escalate). Another
   * device being active doesn't pull a question to it.
   */
  private whereToAsk(
    a: AskRow,
  ): 'host' | { device: string; via: AskVia } | null {
    const active = this.activeDevice(a.user_id);
    if (active === a.host_device) return 'host';
    if (
      a.origin_device === a.host_device ||
      !this.readyDevice(a.user_id, a.origin_device)
    ) {
      return null;
    }
    return {
      device: a.origin_device,
      via: active === a.origin_device ? 'active' : 'origin',
    };
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
    // host and origin; any other device you're at doesn't take them.
    const active = this.activeDevice(r.state.user);
    if (!active) return;
    for (const a of this.store.rows<AskRow>(
      'SELECT * FROM asks WHERE user_id = ? AND escalated = 0',
      r.state.user,
    )) {
      if (active !== a.host_device && active !== a.origin_device) continue;
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

  /** Unanswered for 20 s, or nowhere to show: the origin too, not everyone. */
  private escalate(a: AskRow) {
    const shown = shownOn(a);
    const o = a.origin_device;
    if (o !== a.host_device && !shown.includes(o)) {
      const to = this.readyDevice(a.user_id, o);
      if (to) {
        this.showAsk(to.conn, a, 'escalated');
        shown.push(o);
      }
    }
    this.store.run(
      `UPDATE asks SET escalated = 1, via = 'escalated', shown_on = ?
       WHERE ask_id = ?`,
      JSON.stringify(shown),
      a.ask_id,
    );
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
    this.pushDevices(user);
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
        // The kind only: a message may carry a token or a signed body.
        console.error('fleet.internal', e instanceof Error ? e.name : typeof e);
      })
      .then(() => this.reschedule())
      .catch(() => {});
    this.chain = next;
    return next;
  }

  private async reschedule() {
    const s = this.store;
    const due = [
      s.num('SELECT MIN(deadline_ms) FROM conns'),
      s.num('SELECT MIN(grace_until) FROM pending WHERE claimed = 0'),
      s.num('SELECT MIN(created_ms) FROM pending'),
      s.num('SELECT MIN(created_ms) FROM replies'),
      s.num('SELECT MIN(created_ms) FROM asks WHERE escalated = 0'),
    ];
    const ttl = [0, 0, PENDING_TTL_MS, PENDING_TTL_MS, ESCALATE_MS];
    const at = due
      .map((v, i) => (v === null ? null : v + ttl[i]!))
      .filter((v): v is number => v !== null);
    await this.env.schedule(at.length ? Math.min(...at) : null);
  }

  /** Token bucket; over it, the frame is dropped with one error a second. */
  private allow(conn: Conn): boolean {
    const id = conn.state().id;
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
    const devices: DeviceSummary[] = this.store
      .rows<DeviceRow>(
        'SELECT * FROM devices WHERE user_id = ? ORDER BY device_id',
        user,
      )
      .map((d) => ({
        device_id: d.device_id,
        info: JSON.parse(d.info),
        online: online.has(d.device_id),
        last_seen_ms: d.last_seen_ms,
        public_key: d.public_key,
      }));
    for (const c of conns) this.send(c.conn, { type: 'devices', devices });
  }

  private send(conn: Conn, msg: ServerMessage) {
    try {
      conn.send(JSON.stringify(msg));
    } catch {
      // closed under us; its close handler cleans up
    }
  }

  private error(conn: Conn, code: string, message: string) {
    this.send(conn, { type: 'error', code, message });
  }

  /** Error, then close with the code as the reason: the connection is done. */
  private fail(conn: Conn, code: string, message: string) {
    const closeCode = closeCodeFor(code);
    this.error(conn, code, message);
    const s = conn.state();
    const wasReady = s.phase === 'ready';
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
