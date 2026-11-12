/**
 * The fleet hub of one org (docs/fleet.md): plain TS over small interfaces
 * (SQL, sockets, clock, token check) so it runs in tests without the
 * Workers runtime; `org-hub.ts` is the Durable Object around it.
 *
 * ```text
 * open ─▶ challenge ─▶ hello (ed25519 over the nonce) ─▶ welcome, devices
 *   ─▶ request ─▶ target: request{generation} ─▶ claim ─▶ claim_result
 *              ─▶ reply ─▶ origin            (offline: 10 s grace, 2 min ttl)
 *   ─▶ space_event (host only) ─▶ ring 500 ─▶ subscribers
 *   ─▶ ask (host only) ─▶ active │ origin │ everyone; 20 s ─▶ everyone
 * ```
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
  RemoteSpaceEvent,
  ReplyOutcome,
  ServerMessage,
} from '../gen/fleet';
import {
  ACTIVE_IDLE_MS,
  close,
  closeCodeFor,
  codes,
  ESCALATE_MS,
  GRACE_MS,
  HELLO_TIMEOUT_MS,
  MAX_CHILDREN,
  MAX_DEPTH,
  MAX_DEVICES_PER_USER,
  MAX_FRAME_BYTES,
  MAX_PENDING_PER_USER,
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
  type Routing,
  b64,
  BadMessage,
  byteLength,
  parseClient,
  peekRequest,
  unb64,
  verifyEd25519,
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
      const nonce = new Uint8Array(32);
      crypto.getRandomValues(nonce);
      const state: ConnState = {
        id: crypto.randomUUID(),
        user: caller.userId,
        org: caller.orgId,
        expMs: caller.expMs,
        phase: 'challenged',
        nonce: b64(nonce),
      };
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
          return this.spaceEvent(r, msg);
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
          return this.ask(r, msg.ask);
        case 'ask_resolved':
          return this.askResolved(r, msg.ask_id);
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
        if (conn.state().phase === 'challenged') {
          // Slow, not unauthorized: the device may redial.
          this.fail(conn, codes.BAD_MESSAGE, 'no hello in time');
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
        this.deliverReply(p.user_id, p.origin_device, p.req_id, {
          outcome: 'err',
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
    });
  }

  // ── connect ────────────────────────────────────────────────────────────

  private async hello(conn: Conn, s: ConnState, msg: Of<'hello'>) {
    const nonce = unb64(s.nonce ?? '');
    s.nonce = undefined;
    conn.save(s);
    if (
      !nonce ||
      !(await verifyEd25519(msg.public_key, nonce, msg.signature))
    ) {
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
    // Replies that came while it was away.
    for (const r of this.store.rows<{ req_id: string; outcome: string }>(
      'SELECT req_id, outcome FROM replies WHERE origin_device = ? ORDER BY created_ms',
      deviceId,
    )) {
      this.send(conn, {
        type: 'reply',
        req_id: r.req_id,
        outcome: JSON.parse(r.outcome),
      });
    }
    this.store.run('DELETE FROM replies WHERE origin_device = ?', deviceId);
    // Open questions it was showing, or that went to everyone.
    for (const a of this.store.rows<AskRow>(
      'SELECT * FROM asks WHERE user_id = ? ORDER BY created_ms',
      s.user,
    )) {
      if (a.host_device === deviceId) continue;
      const shown = shownOn(a);
      if (shown.includes(deviceId)) {
        this.showAsk(conn, a, (a.via ?? 'escalated') as AskVia);
      } else if (a.escalated) {
        this.showAsk(conn, a, 'escalated');
        this.setShown(a.ask_id, [...shown, deviceId]);
      }
    }
  }

  private async reauth(r: Ready, msg: Of<'reauth'>) {
    let t: VerifiedToken;
    try {
      t = await this.env.verify(msg.access_token);
    } catch {
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
    r.conn.save(s);
    this.store.setDeadline(s.id, s.user, s.expMs + REAUTH_LEEWAY_MS);
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
        type: 'reply',
        req_id: route.req_id,
        outcome: { outcome: 'err', code, message },
      });
    if (
      envelope.device_id !== r.state.device ||
      route.origin_device !== r.state.device
    ) {
      return refuse(codes.NOT_YOURS, 'a request must come from its origin');
    }
    const target = this.store.device(route.target_device);
    if (!target || target.user_id !== user) {
      return refuse(codes.NOT_YOURS, 'no such device');
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
      const parent = route.parent ? this.store.space(route.parent) : undefined;
      if (parent && parent.user_id !== user) {
        return refuse(codes.NOT_YOURS, 'no such parent space');
      }
      const why = this.depthRefusal(user, route.parent, route.depth);
      if (why) return refuse(codes.DEPTH, why);
    }
    if (route.op === 'answer' && route.ask_id) {
      const a = this.store.ask(route.ask_id);
      if (a && a.user_id === user && a.space === route.space) {
        this.dismiss(
          a,
          shownOn(a).filter((d) => d !== r.state.device),
          'answered_elsewhere',
        );
        this.store.run('DELETE FROM asks WHERE ask_id = ?', a.ask_id);
      }
    }

    const now = this.env.now();
    const to = this.readyDevice(user, target.device_id);
    // Forwarded as received: the three fields, the body's bytes untouched.
    const forward = {
      device_id: envelope.device_id,
      body: envelope.body,
      signature: envelope.signature,
    };
    this.store.run(
      `INSERT INTO pending (req_id, user_id, origin_device, target_device,
         generation, claimed, created_ms, grace_until, envelope, op, space,
         parent, depth)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
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
    if (!rejection) {
      this.store.run(
        'UPDATE pending SET claimed = 1 WHERE req_id = ?',
        msg.req_id,
      );
    }
    this.send(r.conn, {
      type: 'claim_result',
      req_id: msg.req_id,
      claimed: rejection === null,
      rejection,
    });
  }

  private reply(r: Ready, msg: Of<'reply'>) {
    const p = this.store.pending(msg.req_id);
    if (
      !p ||
      p.user_id !== r.state.user ||
      p.target_device !== r.state.device
    ) {
      return this.error(r.conn, codes.NOT_YOURS, 'no such request here');
    }
    if (!p.claimed && msg.outcome.outcome === 'ok') {
      return this.error(r.conn, codes.BAD_MESSAGE, 'claim before replying');
    }
    this.store.run('DELETE FROM pending WHERE req_id = ?', p.req_id);
    if (p.op === 'start_space' && msg.outcome.outcome === 'ok') {
      this.store.run(
        `INSERT INTO spaces
         (space, user_id, host_device, origin_device, parent, depth)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (space) DO NOTHING`,
        p.space,
        p.user_id,
        p.target_device,
        p.origin_device,
        p.parent,
        p.depth,
      );
    }
    this.deliverReply(p.user_id, p.origin_device, p.req_id, msg.outcome);
  }

  private deliverReply(
    user: string,
    origin: string,
    reqId: string,
    outcome: ReplyOutcome,
  ) {
    const to = this.readyDevice(user, origin);
    if (to) {
      this.send(to.conn, { type: 'reply', req_id: reqId, outcome });
      return;
    }
    this.store.run(
      `INSERT OR REPLACE INTO replies (req_id, origin_device, outcome, created_ms)
       VALUES (?, ?, ?, ?)`,
      reqId,
      origin,
      JSON.stringify(outcome),
      this.env.now(),
    );
  }

  // ── events ─────────────────────────────────────────────────────────────

  private spaceEvent(r: Ready, msg: Of<'space_event'>) {
    const sp = this.store.space(msg.space);
    if (
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
    if (msg.seq <= sp.last_seq) return;
    if (msg.seq > sp.last_seq + 1) {
      const gap: RemoteSpaceEvent = {
        kind: 'gap',
        from: sp.last_seq + 1,
        to: msg.seq - 1,
      };
      this.store.addEvent(sp.space, gap.from, gap);
      this.fanOut(sp.user_id, sp.space, gap.from, gap);
    }
    this.store.addEvent(sp.space, msg.seq, msg.event);
    if (msg.event.kind === 'started') {
      this.store.run(
        'UPDATE spaces SET started = ?, started_seq = ? WHERE space = ?',
        JSON.stringify(msg.event),
        msg.seq,
        sp.space,
      );
    }
    this.store.run(
      'UPDATE spaces SET last_seq = ? WHERE space = ?',
      msg.seq,
      sp.space,
    );
    this.fanOut(sp.user_id, sp.space, msg.seq, msg.event);
  }

  private fanOut(
    user: string,
    space: string,
    seq: number,
    event: RemoteSpaceEvent,
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
      if (subs.has(c.state.device)) {
        this.send(c.conn, { type: 'space_event', space, seq, event });
      }
    }
  }

  private subscribe(r: Ready, msg: Of<'subscribe'>) {
    const sp = this.store.space(msg.space);
    if (!sp || sp.user_id !== r.state.user) {
      return this.error(r.conn, codes.NOT_YOURS, 'no such space');
    }
    this.store.run(
      'INSERT OR IGNORE INTO subs (device_id, space) VALUES (?, ?)',
      r.state.device,
      sp.space,
    );
    const ev = (seq: number, event: RemoteSpaceEvent) =>
      this.send(r.conn, { type: 'space_event', space: sp.space, seq, event });
    if (msg.since >= sp.last_seq) return;
    const first =
      this.store.num('SELECT MIN(seq) FROM events WHERE space = ?', sp.space) ??
      sp.last_seq + 1;
    let from = msg.since + 1;
    if (from < first) {
      // Older than the ring: the started event (kept apart), then a gap.
      const s = sp.started_seq;
      if (sp.started && s !== null && s >= from && s < first) {
        ev(s, JSON.parse(sp.started));
        from = s + 1;
      }
      if (from <= first - 1) ev(from, { kind: 'gap', from, to: first - 1 });
    }
    for (const e of this.store.rows<{ seq: number; event: string }>(
      'SELECT seq, event FROM events WHERE space = ? AND seq > ? ORDER BY seq',
      sp.space,
      msg.since,
    )) {
      ev(e.seq, JSON.parse(e.event));
    }
  }

  // ── questions ──────────────────────────────────────────────────────────

  private ask(r: Ready, ask: RemoteAsk) {
    const sp = this.store.space(ask.space);
    if (
      ask.host_device !== r.state.device ||
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
    const existing = this.store.ask(ask.ask_id);
    if (existing) {
      if (existing.user_id !== r.state.user) {
        return this.error(r.conn, codes.NOT_YOURS, 'ask_id taken');
      }
      return; // already open
    }
    this.store.run(
      `INSERT INTO asks (ask_id, user_id, space, host_device, origin_device,
         ask, shown_on, via, escalated, created_ms)
       VALUES (?, ?, ?, ?, ?, ?, '[]', NULL, 0, ?)`,
      ask.ask_id,
      r.state.user,
      ask.space,
      r.state.device,
      sp.origin_device,
      JSON.stringify(ask),
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
   * Your active device (focused, unlocked, input < 60 s, the freshest),
   * else the space's origin if online, else nobody (escalate).
   */
  private whereToAsk(
    a: AskRow,
  ): 'host' | { device: string; via: AskVia } | null {
    const active = this.activeDevice(a.user_id);
    if (active === a.host_device) return 'host';
    if (active) return { device: active, via: 'active' };
    if (
      a.origin_device !== a.host_device &&
      this.readyDevice(a.user_id, a.origin_device)
    ) {
      return { device: a.origin_device, via: 'origin' };
    }
    return null;
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
    // Open, not yet escalated questions follow you to where you are now.
    const active = this.activeDevice(r.state.user);
    if (!active) return;
    for (const a of this.store.rows<AskRow>(
      'SELECT * FROM asks WHERE user_id = ? AND escalated = 0',
      r.state.user,
    )) {
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

  private escalate(a: AskRow) {
    const shown = shownOn(a);
    for (const c of this.ready(a.user_id)) {
      const d = c.state.device;
      if (d === a.host_device || shown.includes(d)) continue;
      this.showAsk(c.conn, a, 'escalated');
      shown.push(d);
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
    this.send(conn, { type: 'ask', ask: JSON.parse(a.ask), via });
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

  private ready(user: string, except?: string): Ready[] {
    const out: Ready[] = [];
    for (const conn of this.env.conns(user)) {
      if (!conn.open) continue;
      const state = conn.state();
      if (state.phase !== 'ready' || state.id === except) continue;
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

function shownOn(a: AskRow): string[] {
  return JSON.parse(a.shown_on) as string[];
}
