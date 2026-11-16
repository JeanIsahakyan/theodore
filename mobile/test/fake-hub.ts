/**
 * A fake cloud for the fleet client: sockets the client opens through an
 * injected platform, a scriptable hub side, a fake account, and a host
 * device (its own key) that signs replies, events and asks.
 */
import { domainMessage, type Domain } from '../src/fleet/crypto';
import type { FleetPlatform, FleetSocket } from '../src/fleet/platform-types';
import type { AuthClient, Session } from '../src/auth/types';
import type {
  ClientMessage,
  DeviceSummary,
  ServerMessage,
  SignedEnvelope,
} from '../src/gen/fleet';
import { toBase64, utf8 } from '../src/keys/base64';
import { seedKey } from '../src/keys/ed25519';
import { memoryStorage, type SecretStorage } from '../src/keys/storage-types';
import type { DeviceKey } from '../src/keys/types';

export const ME = 'dev_00000000-0000-4000-8000-0000000000a1';
export const HOST = 'dev_00000000-0000-4000-8000-0000000000b2';
export const OTHER = 'dev_00000000-0000-4000-8000-0000000000c3';
export const ORG = 'org_test';
export const CLOUD = 'https://cloud.test';

export const hostKey = seedKey(new Uint8Array(32).fill(2));
export const strangerKey = seedKey(new Uint8Array(32).fill(3));
export const originKey = seedKey(new Uint8Array(32).fill(4));

export const TIMING = {
  backoffBaseMs: 5,
  backoffMaxMs: 20,
  pingEveryMs: 1_000,
  handshakeMs: 1_000,
  replyWaitMs: 150,
  startWaitMs: 100,
  pendingTtlMs: 2_000,
};

export async function waitFor(
  pred: () => boolean,
  what = 'condition',
  ms = 1500,
): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FakeSocket implements FleetSocket {
  sent: ClientMessage[] = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data?: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(
    readonly url: string,
    readonly token: string,
  ) {}

  send(text: string) {
    if (this.closed) throw new Error('closed');
    this.sent.push(JSON.parse(text) as ClientMessage);
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
  /** Hub → client. */
  deliver(msg: ServerMessage | Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  /** The hub closes the socket. */
  drop(code = 1006, reason = '') {
    this.closed = { code, reason };
    this.onclose?.({ code, reason });
  }
  of<T extends ClientMessage['type']>(type: T) {
    return this.sent.filter((m) => m.type === type) as Extract<
      ClientMessage,
      { type: T }
    >[];
  }
}

export function fakePlatform(over: Partial<FleetPlatform> = {}) {
  const sockets: FakeSocket[] = [];
  let active: ((a: boolean) => void) | null = null;
  let n = 0;
  // Passed in: the same device after a restart.
  const storage: SecretStorage = over.storage ?? memoryStorage();
  const data: SecretStorage = over.data ?? memoryStorage();
  const platform: FleetPlatform = {
    kind: 'mobile',
    os: 'macos',
    name: 'Test iPhone',
    appVersion: '1.0.0',
    closeInBackground: false,
    openSocket(url, token) {
      const s = new FakeSocket(url, token);
      sockets.push(s);
      queueMicrotask(() => s.onopen?.());
      return s;
    },
    randomUUID: () =>
      `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    storage,
    data,
    onActive(l) {
      active = l;
      return () => {
        active = null;
      };
    },
    ...over,
  };
  return {
    platform,
    sockets,
    storage,
    data,
    last: () => sockets[sockets.length - 1]!,
    setActive: (a: boolean) => active?.(a),
  };
}

export function session(token = 'tok-1', org: string | null = ORG): Session {
  return {
    userId: 'user_1',
    email: 'a@b.c',
    name: null,
    accessToken: token,
    refreshToken: 'r',
    expiresAt: Date.now() + 3_600_000,
    organizationId: org,
    role: null,
  };
}

export function fakeAuth(initial: Session | null = session()) {
  let current = initial;
  const listeners = new Set<(s: Session | null) => void>();
  const auth: AuthClient = {
    current: async () => current,
    accessToken: async () => current?.accessToken ?? null,
    signIn: async () => ({ kind: 'cancelled' }),
    chooseOrganization: async () => ({ kind: 'cancelled' }),
    switchOrganization: async () => {
      throw new Error('no');
    },
    organizations: async () => [],
    signOut: async () => {
      current = null;
      listeners.forEach((l) => l(null));
    },
    onChange(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return {
    auth,
    emit(s: Session | null) {
      current = s;
      listeners.forEach((l) => l(s));
    },
  };
}

/** A body signed the way Rust's `seal_as` does it. */
export async function sealAs(
  body: object,
  deviceId: string,
  key: DeviceKey,
  domain: Domain,
): Promise<SignedEnvelope> {
  const text = JSON.stringify(body);
  return {
    device_id: deviceId,
    body: text,
    signature: await key.sign(domainMessage(domain, utf8(text))),
  };
}

export function device(
  id: string,
  key: DeviceKey,
  over: Partial<DeviceSummary['info']> = {},
): DeviceSummary {
  return {
    device_id: id,
    online: true,
    last_seen_ms: 0,
    public_key: key.publicKey,
    info: {
      name: 'Mac <b>Studio</b>!',
      os: 'macos',
      kind: 'desktop',
      app_version: '0.1.18',
      projects: [{ id: 'p1', name: 'Theodore' }],
      accepts_remote: true,
      max_mode: 'edit',
      ...over,
    },
  };
}

export const NONCE = toBase64(new Uint8Array(32).fill(9));

/** Runs challenge → hello → welcome → devices on the newest socket. */
export async function handshake(
  hub: ReturnType<typeof fakePlatform>,
  devices: DeviceSummary[] = [],
  count = hub.sockets.length,
) {
  await waitFor(() => hub.sockets.length >= Math.max(count, 1), 'a socket');
  const s = hub.last();
  s.deliver({ type: 'challenge', nonce: NONCE });
  await waitFor(() => s.of('hello').length === 1, 'hello');
  s.deliver({ type: 'welcome', device_id: ME, generation: 1, resume: {} });
  s.deliver({ type: 'devices', devices });
  return s;
}
