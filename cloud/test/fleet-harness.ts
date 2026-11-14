// An OrgHub without the Workers runtime: node:sqlite for storage, fake
// sockets, a fake clock and a token table for reauth.
import { DatabaseSync } from 'node:sqlite';
import type {
  ClientMessage,
  DeviceInfo,
  RemoteAsk,
  RemoteRequest,
  RemoteSpaceEvent,
  ReplyBody,
  ReplyOutcome,
  ServerMessage,
  SignedEnvelope,
  SpaceEventBody,
} from '../src/gen/fleet';
import {
  Hub,
  type Conn,
  type ConnState,
  type VerifiedToken,
} from '../src/fleet/hub';
import { PROTOCOL_VERSION } from '../src/fleet/limits';
import { b64, signedBytes, unb64, type Domain } from '../src/fleet/wire';

export const T0 = 1_800_000_000_000;

export class FakeConn implements Conn {
  open = true;
  sent: ServerMessage[] = [];
  closedWith?: { code: number; reason: string };
  private st?: ConnState;

  /** The DO tags a socket with its user on accept, before `open` runs. */
  constructor(readonly tag?: string) {}

  /** Its user, as a getWebSockets(tag) filter would see it. */
  get user(): string | undefined {
    return this.tag ?? this.st?.user;
  }
  state(): ConnState {
    // Attachments come back as copies (null before the first save), like
    // deserializeAttachment.
    return (this.st ? structuredClone(this.st) : null) as ConnState;
  }
  save(s: ConnState) {
    this.st = structuredClone(s);
  }
  send(text: string) {
    if (!this.open) throw new Error('socket closed');
    this.sent.push(JSON.parse(text) as ServerMessage);
  }
  close(code: number, reason: string) {
    this.open = false;
    this.closedWith = { code, reason };
  }
}

type Msg<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

export const info = (name = 'mac', over: Partial<DeviceInfo> = {}) =>
  ({
    name,
    os: 'macos',
    kind: 'desktop',
    app_version: '0.1.17',
    projects: [{ id: 'p1', name: 'theodore' }],
    accepts_remote: true,
    max_mode: 'edit',
    ...over,
  }) satisfies DeviceInfo;

export class Device {
  conn!: FakeConn;
  id?: string;
  generation = 0;
  publicKey = '';
  private keys!: CryptoKeyPair;

  constructor(
    readonly h: Harness,
    readonly user: string,
    readonly name: string,
  ) {}

  async init() {
    this.keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const raw = await crypto.subtle.exportKey('raw', this.keys.publicKey);
    this.publicKey = b64(new Uint8Array(raw as ArrayBuffer));
    return this;
  }

  async signB64(bytes: Uint8Array): Promise<string> {
    const sig = await crypto.subtle.sign(
      { name: 'Ed25519' },
      this.keys.privateKey,
      bytes,
    );
    return b64(new Uint8Array(sig));
  }

  /** A hello's signature over a challenge nonce (base64). */
  signHello(nonce: string): Promise<string> {
    return this.signB64(signedBytes('hello', unb64(nonce)!));
  }

  /** `body` as JSON, signed by this device for `domain`. */
  async seal(
    domain: Domain,
    body: unknown,
    as = this.id!,
  ): Promise<SignedEnvelope> {
    const text = JSON.stringify(body);
    const bytes = signedBytes(domain, new TextEncoder().encode(text));
    return { device_id: as, body: text, signature: await this.signB64(bytes) };
  }

  /** One event of a space this device hosts, signed as its host. */
  async emit(space: string, seq: number, event: RemoteSpaceEvent) {
    const body: SpaceEventBody = { space, seq, host_device: this.id!, event };
    const envelope = await this.seal('event', body);
    await this.send({ type: 'space_event', envelope });
    return envelope;
  }

  /** A question set of a space this device hosts, signed as its host. */
  async raise(ask: RemoteAsk) {
    const envelope = await this.seal('ask', ask);
    await this.send({ type: 'ask', envelope });
    return envelope;
  }

  /** Opens a socket and returns it with its challenge nonce, no hello yet. */
  async open(
    o: { org?: string; expMs?: number } = {},
  ): Promise<{ conn: FakeConn; nonce: string }> {
    const conn = new FakeConn(this.user);
    this.h.conns.push(conn);
    await this.h.hub.open(conn, {
      userId: this.user,
      orgId: o.org ?? 'org_1',
      expMs: o.expMs ?? this.h.now + 3_600_000,
    });
    const challenge = conn.sent.shift() as Msg<'challenge'>;
    if (challenge.type !== 'challenge') throw new Error('no challenge');
    this.conn = conn;
    return { conn, nonce: challenge.nonce };
  }

  /** Full connect: challenge, signed hello, welcome. */
  async connect(
    o: {
      deviceId?: string | null;
      expMs?: number;
      spaces?: { space: string; seq: number }[];
    } = {},
  ): Promise<Msg<'welcome'>> {
    const { nonce } = await this.open({ expMs: o.expMs });
    await this.send({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      device_id: o.deviceId === undefined ? (this.id ?? null) : o.deviceId,
      public_key: this.publicKey,
      signature: await this.signHello(nonce),
      info: info(this.name),
      spaces: o.spaces ?? [],
    });
    const welcome = this.take('welcome')[0];
    if (!welcome) throw new Error(`no welcome: ${JSON.stringify(this.sent)}`);
    this.id = welcome.device_id;
    this.generation = welcome.generation;
    return welcome;
  }

  send(msg: ClientMessage | string | ArrayBuffer): Promise<void> {
    const data =
      typeof msg === 'string' || msg instanceof ArrayBuffer
        ? msg
        : JSON.stringify(msg);
    return this.h.hub.message(this.conn, data);
  }

  async disconnect() {
    this.conn.open = false;
    await this.h.hub.closed(this.conn);
  }

  get sent(): ServerMessage[] {
    return this.conn.sent;
  }

  /** Removes and returns the frames of one type received so far. */
  take<T extends ServerMessage['type']>(type: T): Msg<T>[] {
    const got = this.conn.sent.filter((m) => m.type === type) as Msg<T>[];
    this.conn.sent = this.conn.sent.filter((m) => m.type !== type);
    return got;
  }

  clear() {
    this.conn.sent = [];
  }

  /** Received space events and gaps, in order: seq, or `gap<from>-<to>`. */
  stream(): (number | string)[] {
    const out: (number | string)[] = [];
    const rest: ServerMessage[] = [];
    for (const m of this.conn.sent) {
      if (m.type === 'space_event') {
        out.push((JSON.parse(m.envelope.body) as SpaceEventBody).seq);
      } else if (m.type === 'space_gap') {
        out.push(`gap${m.from}-${m.to}`);
      } else rest.push(m);
    }
    this.conn.sent = rest;
    return out;
  }

  /**
   * A request for `target`, bound to its key as the cloud pins it (what the
   * origin would have pinned), unless `targetKey` says otherwise.
   */
  async envelope(
    target: string,
    op: RemoteRequest['op'],
    reqId = `req_${crypto.randomUUID()}`,
    targetKey = this.h.keyOf(target),
  ): Promise<SignedEnvelope> {
    const req: RemoteRequest = {
      req_id: reqId,
      origin_device: this.id!,
      target_device: target,
      target_key: targetKey,
      issued_at_ms: this.h.now,
      op,
    };
    return this.seal('request', req);
  }

  async request(
    target: string,
    op: RemoteRequest['op'],
    reqId?: string,
    targetKey?: string,
  ) {
    const envelope = await this.envelope(target, op, reqId, targetKey);
    await this.send({ type: 'request', envelope });
    return { envelope, reqId: JSON.parse(envelope.body).req_id as string };
  }

  /**
   * This device's signed reply to `reqId` as its target; the origin is the
   * pending request's unless `over` says otherwise.
   */
  async reply(
    reqId: string,
    outcome: ReplyOutcome,
    over: Partial<ReplyBody> & { domain?: Domain; as?: string } = {},
  ): Promise<SignedEnvelope> {
    const { domain = 'reply', as, ...fields } = over;
    const body: ReplyBody = {
      req_id: reqId,
      origin_device: this.h.originOf(reqId),
      target_device: this.id!,
      outcome,
      ...fields,
    };
    const envelope = await this.seal(domain, body, as);
    await this.send({ type: 'reply', envelope });
    return envelope;
  }
}

export class Harness {
  now = T0;
  conns: FakeConn[] = [];
  tokens = new Map<string, VerifiedToken>();
  hub: Hub;
  scheduled: (number | null)[] = [];

  readonly db: DatabaseSync;

  constructor(db = new DatabaseSync(':memory:')) {
    this.db = db;
    this.hub = new Hub({
      sql: { exec: (q, ...b) => db.prepare(q).all(...b) },
      now: () => this.now,
      conns: (user) =>
        this.conns.filter(
          (c) => c.open && c.user && (user === undefined || c.user === user),
        ),
      verify: async (t) => {
        const v = this.tokens.get(t);
        if (!v) throw new Error('bad token');
        return v;
      },
      schedule: (at) => {
        this.scheduled.push(at);
      },
    });
  }

  async device(user = 'user_1', name = 'mac') {
    return new Device(this, user, name).init();
  }

  /** A device's pinned key, or a placeholder for one the cloud doesn't know. */
  keyOf(device: string): string {
    const row = this.db
      .prepare('SELECT public_key FROM devices WHERE device_id = ?')
      .all(device)[0] as { public_key: string } | undefined;
    return row?.public_key ?? 'AAAA';
  }

  /** A pending request's origin ('' once it's settled). */
  originOf(reqId: string): string {
    const row = this.db
      .prepare('SELECT origin_device FROM pending WHERE req_id = ?')
      .all(reqId)[0] as { origin_device: string } | undefined;
    return row?.origin_device ?? '';
  }

  /** Moves the clock and lets the alarm run. */
  async tick(ms: number) {
    this.now += ms;
    await this.hub.alarm();
  }
}

export const startOp = (
  space: string,
  o: { parent?: string | null; depth?: number } = {},
): RemoteRequest['op'] => ({
  op: 'start_space',
  space,
  project_id: 'p1',
  goal: 'do it',
  mode: 'edit',
  parent: o.parent ?? null,
  depth: o.depth ?? 0,
});

/** origin starts `space` on host: request, claim, ok reply. */
export async function startSpace(
  origin: Device,
  host: Device,
  space: string,
  o: { parent?: string | null; depth?: number } = {},
) {
  const { reqId } = await origin.request(host.id!, startOp(space, o));
  const req = host.take('request')[0];
  if (!req) throw new Error(`not routed: ${JSON.stringify(origin.sent)}`);
  await host.send({ type: 'claim', req_id: reqId, generation: req.generation });
  await host.reply(reqId, {
    outcome: 'ok',
    value: { space, name: 'Space', branch: 'b' },
  });
  host.take('claim_result');
  origin.take('reply');
  return reqId;
}

/** Signed replies received so far: 'ok' or the target's err code. */
export const replies = (d: Device) =>
  d.take('reply').map((r) => {
    const body = JSON.parse(r.envelope.body) as ReplyBody;
    return body.outcome.outcome === 'ok' ? 'ok' : body.outcome.code;
  });

/** The cloud's own refusals received so far, by code. */
export const refusals = (d: Device) => d.take('refused').map((r) => r.code);
