// An OrgHub without the Workers runtime: node:sqlite for storage, fake
// sockets, a fake clock and a token table for reauth.
import { DatabaseSync } from 'node:sqlite';
import type {
  ClientMessage,
  DeviceInfo,
  RemoteRequest,
  ServerMessage,
  SignedEnvelope,
} from '../src/gen/fleet';
import {
  Hub,
  type Conn,
  type ConnState,
  type VerifiedToken,
} from '../src/fleet/hub';
import { b64, unb64 } from '../src/fleet/wire';

export const T0 = 1_800_000_000_000;

export class FakeConn implements Conn {
  open = true;
  sent: ServerMessage[] = [];
  closedWith?: { code: number; reason: string };
  private st?: ConnState;

  /** Its user, as a getWebSockets(tag) filter would see it. */
  get user(): string | undefined {
    return this.st?.user;
  }
  state(): ConnState {
    // Attachments come back as copies, like deserializeAttachment.
    return structuredClone(this.st!);
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

  /** Opens a socket and returns it with its challenge nonce, no hello yet. */
  async open(
    o: { org?: string; expMs?: number } = {},
  ): Promise<{ conn: FakeConn; nonce: string }> {
    const conn = new FakeConn();
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
      protocol: 1,
      device_id: o.deviceId === undefined ? (this.id ?? null) : o.deviceId,
      public_key: this.publicKey,
      signature: await this.signB64(unb64(nonce)!),
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

  async envelope(
    target: string,
    op: RemoteRequest['op'],
    reqId = `req_${crypto.randomUUID()}`,
  ): Promise<SignedEnvelope> {
    const req: RemoteRequest = {
      req_id: reqId,
      origin_device: this.id!,
      target_device: target,
      issued_at_ms: this.h.now,
      op,
    };
    const body = JSON.stringify(req);
    return {
      device_id: this.id!,
      body,
      signature: await this.signB64(new TextEncoder().encode(body)),
    };
  }

  async request(target: string, op: RemoteRequest['op'], reqId?: string) {
    const envelope = await this.envelope(target, op, reqId);
    await this.send({ type: 'request', envelope });
    return { envelope, reqId: JSON.parse(envelope.body).req_id as string };
  }
}

export class Harness {
  now = T0;
  conns: FakeConn[] = [];
  tokens = new Map<string, VerifiedToken>();
  hub: Hub;
  scheduled: (number | null)[] = [];

  constructor() {
    const db = new DatabaseSync(':memory:');
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
  await host.send({
    type: 'reply',
    req_id: reqId,
    outcome: { outcome: 'ok', value: { space, name: 'Space', branch: 'b' } },
  });
  host.take('claim_result');
  origin.take('reply');
  return reqId;
}
