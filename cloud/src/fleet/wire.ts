/**
 * Reading what a device sends: every frame is untrusted, so each message is
 * checked field by field into the generated types (src/gen/fleet.ts) before
 * the hub looks at it. A signed request's body is read only for routing;
 * event, ask and reply bodies are read, checked against their signer's
 * pinned key, and forwarded as the bytes received.
 */
import type {
  ClientMessage,
  DeviceInfo,
  RemoteAsk,
  RemoteQuestion,
  RemoteSpaceEvent,
  ReplyBody,
  SignedEnvelope,
  SpaceCursor,
  SpaceEventBody,
} from '../gen/fleet';
import {
  codes,
  MAX_EVENT_BYTES,
  MAX_FRAME_BYTES,
  MAX_INFO_BYTES,
  NONCE_BYTES,
  PROTOCOL_VERSION,
} from './limits';

export class BadMessage extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BadMessage';
  }
}

type Obj = Record<string, unknown>;

const bad = (message: string) => new BadMessage(codes.BAD_MESSAGE, message);

function obj(v: unknown, what: string): Obj {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v as Obj;
  throw bad(`${what} must be an object`);
}

/** A string of at most `max` chars; non-empty unless `empty`. */
function str(o: Obj, k: string, max = 128, empty = false): string {
  const v = o[k];
  if (typeof v !== 'string' || v.length > max || (!empty && v === '')) {
    throw bad(`${k} must be a string of at most ${max} chars`);
  }
  return v;
}

function optStr(o: Obj, k: string, max = 128): string | null {
  return o[k] === undefined || o[k] === null ? null : str(o, k, max);
}

function uint(o: Obj, k: string): number {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw bad(`${k} must be a non-negative integer`);
  }
  return v;
}

function bool(o: Obj, k: string): boolean {
  if (typeof o[k] !== 'boolean') throw bad(`${k} must be a boolean`);
  return o[k];
}

function arr(o: Obj, k: string, max: number): unknown[] {
  const v = o[k];
  if (!Array.isArray(v) || v.length > max) {
    throw bad(`${k} must be a list of at most ${max}`);
  }
  return v;
}

function oneOf<T extends string>(o: Obj, k: string, allowed: readonly T[]): T {
  const v = o[k];
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw bad(`${k} must be one of ${allowed.join(', ')}`);
  }
  return v as T;
}

const MODES = ['ask', 'plan', 'edit', 'run'] as const;

function deviceInfo(v: unknown): DeviceInfo {
  const o = obj(v, 'info');
  const info: DeviceInfo = {
    name: str(o, 'name', 100),
    os: oneOf(o, 'os', ['macos', 'linux']),
    kind: oneOf(o, 'kind', ['desktop', 'daemon']),
    app_version: str(o, 'app_version', 64),
    projects: arr(o, 'projects', 200).map((p) => {
      const po = obj(p, 'project');
      return { id: str(po, 'id', 128), name: str(po, 'name', 200) };
    }),
    accepts_remote: bool(o, 'accepts_remote'),
    max_mode: oneOf(o, 'max_mode', MODES),
  };
  if (JSON.stringify(info).length > MAX_INFO_BYTES) {
    throw new BadMessage(codes.TOO_LARGE, 'device info too large');
  }
  return info;
}

function cursor(v: unknown): SpaceCursor {
  const o = obj(v, 'space cursor');
  return { space: str(o, 'space'), seq: uint(o, 'seq') };
}

function envelope(v: unknown): SignedEnvelope {
  const o = obj(v, 'envelope');
  return {
    device_id: str(o, 'device_id', 64),
    body: str(o, 'body', MAX_FRAME_BYTES),
    signature: str(o, 'signature', 128),
  };
}

const EVENT_KINDS = [
  'started',
  'status',
  'turn_started',
  'tool',
  'reply',
  'turn_ended',
  'question',
  'question_cleared',
] as const;

/** Only the kind is read; the event travels as the host signed it. */
function spaceEvent(v: unknown): RemoteSpaceEvent {
  const o = obj(v, 'event');
  const kind = oneOf(o, 'kind', EVENT_KINDS);
  // The cloud keeps a space's status (finished spaces go first at the cap).
  if (kind === 'status') {
    oneOf(o, 'status', ['running', 'idle', 'waiting', 'stopped', 'failed']);
  }
  return o as RemoteSpaceEvent;
}

function question(v: unknown): RemoteQuestion {
  const o = obj(v, 'question');
  return {
    question: str(o, 'question', 4000),
    options: arr(o, 'options', 50).map((x) => {
      if (typeof x !== 'string' || x.length > 500) throw bad('bad option');
      return x;
    }),
    multi: bool(o, 'multi'),
  };
}

function remoteAsk(v: unknown): RemoteAsk {
  const o = obj(v, 'ask');
  return {
    ask_id: str(o, 'ask_id'),
    space: str(o, 'space'),
    host_device: str(o, 'host_device', 64),
    from: str(o, 'from', 300, true),
    questions: arr(o, 'questions', 20).map(question),
  };
}

/** One frame from a device, checked. Throws [`BadMessage`]. */
export function parseClient(raw: string): ClientMessage {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw bad('frame is not JSON');
  }
  const o = obj(v, 'message');
  switch (o.type) {
    case 'hello': {
      // The version first: a future hello may not parse as this one.
      if (o.protocol !== PROTOCOL_VERSION) {
        throw new BadMessage(
          codes.VERSION,
          `protocol ${PROTOCOL_VERSION} only`,
        );
      }
      return {
        type: 'hello',
        protocol: PROTOCOL_VERSION,
        device_id: optStr(o, 'device_id', 64),
        public_key: str(o, 'public_key', 64),
        signature: str(o, 'signature', 128),
        info: deviceInfo(o.info),
        spaces: arr(o, 'spaces', 10_000).map(cursor),
      };
    }
    case 'reauth':
      return { type: 'reauth', access_token: str(o, 'access_token', 8192) };
    case 'presence':
      return {
        type: 'presence',
        focused: bool(o, 'focused'),
        locked: bool(o, 'locked'),
        idle_ms: uint(o, 'idle_ms'),
      };
    case 'announce':
      return { type: 'announce', info: deviceInfo(o.info) };
    case 'request':
      return { type: 'request', envelope: envelope(o.envelope) };
    case 'claim':
      return {
        type: 'claim',
        req_id: str(o, 'req_id'),
        generation: uint(o, 'generation'),
      };
    case 'reply':
      return { type: 'reply', envelope: envelope(o.envelope) };
    case 'space_event':
      return { type: 'space_event', envelope: envelope(o.envelope) };
    case 'ask':
      return { type: 'ask', envelope: envelope(o.envelope) };
    case 'ask_resolved':
      return { type: 'ask_resolved', ask_id: str(o, 'ask_id') };
    case 'subscribe':
      return {
        type: 'subscribe',
        space: str(o, 'space'),
        since: uint(o, 'since'),
      };
    case 'unsubscribe':
      return { type: 'unsubscribe', space: str(o, 'space') };
    case 'remove_device':
      return { type: 'remove_device', device_id: str(o, 'device_id', 64) };
    default:
      throw bad('unknown message type');
  }
}

/** What the cloud reads from a signed body: routing fields, nothing else. */
export interface Routing {
  req_id: string;
  origin_device: string;
  target_device: string;
  /** The target's key as the origin pinned it. */
  target_key: string;
  op: 'start_space' | 'send' | 'stop' | 'answer';
  space: string;
  /** start_space */
  parent: string | null;
  depth: number;
  /** answer */
  ask_id: string | null;
}

function parseBody(body: string, what: string): Obj {
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    throw bad(`${what} is not JSON`);
  }
  return obj(v, what);
}

export function peekRequest(body: string): Routing {
  const o = parseBody(body, 'request body');
  const op = obj(o.op, 'op');
  const kind = oneOf(op, 'op', ['start_space', 'send', 'stop', 'answer']);
  return {
    req_id: str(o, 'req_id'),
    origin_device: str(o, 'origin_device', 64),
    target_device: str(o, 'target_device', 64),
    target_key: str(o, 'target_key', 64),
    op: kind,
    space: str(op, 'space'),
    parent: kind === 'start_space' ? optStr(op, 'parent') : null,
    depth: kind === 'start_space' ? uint(op, 'depth') : 0,
    ask_id: kind === 'answer' ? str(op, 'ask_id') : null,
  };
}

/** A host's space event body: what the cloud stores and orders by. */
export function peekEvent(body: string): SpaceEventBody {
  if (new TextEncoder().encode(body).byteLength > MAX_EVENT_BYTES) {
    throw new BadMessage(codes.TOO_LARGE, 'space event too large');
  }
  const o = parseBody(body, 'event body');
  return {
    space: str(o, 'space'),
    seq: uint(o, 'seq'),
    host_device: str(o, 'host_device', 64),
    event: spaceEvent(o.event),
  };
}

/** What the cloud reads from a target's signed reply. */
export interface ReplyRouting {
  req_id: ReplyBody['req_id'];
  origin_device: ReplyBody['origin_device'];
  target_device: ReplyBody['target_device'];
  /** Only its kind: the outcome travels as the target signed it. */
  outcome: ReplyBody['outcome']['outcome'];
}

export function peekReply(body: string): ReplyRouting {
  const o = parseBody(body, 'reply body');
  return {
    req_id: str(o, 'req_id'),
    origin_device: str(o, 'origin_device', 64),
    target_device: str(o, 'target_device', 64),
    outcome: oneOf(obj(o.outcome, 'outcome'), 'outcome', ['ok', 'err']),
  };
}

/** A host's question set. */
export function peekAsk(body: string): RemoteAsk {
  return remoteAsk(parseBody(body, 'ask body'));
}

/**
 * What a signature is for (`fleet_protocol::Domain`): each kind signs
 * `"theodore-fleet-<kind>-v3\0" ‖ bytes`, so one never verifies as another.
 */
export type Domain = 'hello' | 'request' | 'event' | 'ask' | 'reply';

/** The exact bytes signed for `msg` in `domain`. */
export function signedBytes(domain: Domain, msg: Uint8Array): Uint8Array {
  const tag = new TextEncoder().encode(`theodore-fleet-${domain}-v3\0`);
  const out = new Uint8Array(tag.length + msg.length);
  out.set(tag);
  out.set(msg, tag.length);
  return out;
}

/** A hello's signature over the challenge nonce (exactly NONCE_BYTES). */
export function verifyHello(
  publicKey: string,
  nonce: Uint8Array,
  signature: string,
): Promise<boolean> {
  if (nonce.length !== NONCE_BYTES) return Promise.resolve(false);
  return verifyEd25519(publicKey, signedBytes('hello', nonce), signature);
}

/** An envelope's signature for `domain`, by the holder of `publicKey`. */
export function verifyEnvelope(
  publicKey: string,
  env: SignedEnvelope,
  domain: Domain,
): Promise<boolean> {
  const body = new TextEncoder().encode(env.body);
  return verifyEd25519(publicKey, signedBytes(domain, body), env.signature);
}

/** UTF-8 size without encoding when the length alone settles it. */
export function byteLength(s: string): number {
  if (s.length * 3 <= MAX_FRAME_BYTES) return s.length;
  return new TextEncoder().encode(s).byteLength;
}

export function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function unb64(s: string): Uint8Array | null {
  try {
    const raw = atob(s);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Ed25519 over `msg`, both base64 (same rule as `keys::verify`). */
export async function verifyEd25519(
  publicKey: string,
  msg: Uint8Array,
  signature: string,
): Promise<boolean> {
  const pk = unb64(publicKey);
  const sig = unb64(signature);
  if (!pk || pk.length !== 32 || !sig || sig.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      pk,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, msg);
  } catch {
    return false;
  }
}
