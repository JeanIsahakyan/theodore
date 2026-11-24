/**
 * Reading what a device sends: every frame is untrusted, so each message is
 * checked field by field into the generated types (src/gen/fleet.ts) before
 * the hub looks at it. A signed request's body is read only for routing;
 * event, ask and reply bodies are read, checked against their signer's
 * pinned key, and forwarded as the bytes received; so is a host's confirm.
 */
import type {
  ClientMessage,
  Delegation,
  DeviceInfo,
  FleetAgentInfo,
  FleetModelInfo,
  McpAutoState,
  RemoteAsk,
  RemoteConfirm,
  RemoteQuestion,
  RemoteSpaceEvent,
  ReplyBody,
  SignedEnvelope,
  SpaceCursor,
  SpaceEventBody,
} from '../gen/fleet';
import {
  codes,
  CONFIRM_TEXT_MAX,
  MAX_AGENT_ID_CHARS,
  MAX_ANY_SPACE_ID_CHARS,
  MAX_ANY_SPACE_TEXT_CHARS,
  MAX_AGENT_LABEL_CHARS,
  MAX_AGENT_MODELS,
  MAX_AGENTS,
  MAX_EFFORT_CHARS,
  MAX_EVENT_BYTES,
  MAX_MODEL_EFFORTS,
  MAX_MODEL_ID_CHARS,
  MAX_FRAME_BYTES,
  MAX_INFO_BYTES,
  MAX_MCP_AUTO,
  MAX_MIRROR_ID_CHARS,
  MAX_PUSH_TOKEN_CHARS,
  MAX_READ_MESSAGES,
  MIN_PROTOCOL_VERSION,
  MIRROR_KEPT,
  MIRROR_RELAYED,
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

/** Absent or null: null; else a non-negative integer. */
function optUint(o: Obj, k: string): number | null {
  return o[k] === undefined || o[k] === null ? null : uint(o, k);
}

/**
 * A string of at most `max` characters (code points, as Rust counts
 * `chars`); non-empty unless `empty`.
 */
function chars(o: Obj, k: string, max: number, empty = false): string {
  const v = str(o, k, 2 * max, empty);
  if ([...v].length > max) {
    throw bad(`${k} must be a string of at most ${max} characters`);
  }
  return v;
}

function optChars(o: Obj, k: string, max: number): string | null {
  return o[k] === undefined || o[k] === null ? null : chars(o, k, max);
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
/** `QueuedMessageAction`. */
const QUEUED_ACTIONS = ['send', 'cancel'] as const;
const MCP_AUTOS = ['off', 'edit', 'full'] as const;

/** Protocol 6: confirms and auto mode (frames, ops, `mcp_auto`). */
export const V6 = 6;
/** Protocol 7: ops on any space of a computer, the `sub_space` mirror. */
export const V7 = 7;
/** Protocol 9: `archive_space` / `unarchive_space` on a hosted space. */
export const V9 = 9;
/** Protocol 10: `queued_message` (Send now / Remove on a queued message). */
export const V10 = 10;

/** Ops on a space the target hosts for the origin that archive it (protocol 9). */
export const ARCHIVE_OPS = ['archive_space', 'unarchive_space'] as const;
export type ArchiveOp = (typeof ARCHIVE_OPS)[number];

export const archives = (op: string): op is ArchiveOp =>
  (ARCHIVE_OPS as readonly string[]).includes(op);

/**
 * Ops on any of the target's own spaces, by its local id (protocol 7,
 * `RemoteOp::on_any_space`): on no space the cloud tracks.
 */
export const ANY_SPACE_OPS = [
  'list_spaces',
  'read_space',
  'ask_space',
  'send_to',
  'answer_space',
  'merge_child',
  'queued_message',
] as const;
export type AnySpaceOp = (typeof ANY_SPACE_OPS)[number];

export const onAnySpace = (op: string): op is AnySpaceOp =>
  (ANY_SPACE_OPS as readonly string[]).includes(op);

/** The protocol a target needs to take `op`. */
export function protocolFor(op: string): number {
  if (op === 'confirm' || op === 'set_mcp_auto') return V6;
  if (archives(op)) return V9;
  if (op === 'queued_message') return V10;
  return onAnySpace(op) ? V7 : MIN_PROTOCOL_VERSION;
}

/** Device kinds requests may target (`DeviceKind::hosts`). */
export const HOST_KINDS: readonly DeviceInfo['kind'][] = ['desktop', 'daemon'];

/** Whether a device of this kind runs spaces (and so may be a target). */
export const hosts = (kind: DeviceInfo['kind']) => HOST_KINDS.includes(kind);

/**
 * Kinds a connection of `protocol` may say it is: 3 knows only hosts. `mcp`
 * is the cloud's own device (src/mcp/): only its in-process connection
 * (`internal`) says it, and it says nothing else; a socket never may.
 */
const kindsFor = (
  protocol: number,
  internal: boolean,
): readonly DeviceInfo['kind'][] => {
  if (internal) return ['mcp'];
  return protocol >= 4 ? [...HOST_KINDS, 'mobile', 'web'] : HOST_KINDS;
};

/** The protocol a connection needs to read a device of `kind` in a list. */
export function protocolToSee(kind: DeviceInfo['kind']): number {
  switch (kind) {
    case 'mobile':
    case 'web':
      return 4;
    case 'mcp':
      return 5;
    default:
      return 3;
  }
}

/** A `string[]` of at most `max` items, each a non-empty string ≤ `chars`. */
function strs(o: Obj, k: string, max: number, chars: number): string[] {
  return arr(o, k, max).map((x) => {
    if (typeof x !== 'string' || x === '' || x.length > chars) {
      throw bad(`${k} must hold strings of 1 to ${chars} chars`);
    }
    return x;
  });
}

function modelInfo(v: unknown): FleetModelInfo {
  const o = obj(v, 'model');
  return {
    id: str(o, 'id', MAX_MODEL_ID_CHARS),
    label: str(o, 'label', MAX_AGENT_LABEL_CHARS, true),
    efforts:
      o.efforts === undefined
        ? []
        : strs(o, 'efforts', MAX_MODEL_EFFORTS, MAX_EFFORT_CHARS),
    default_effort: optStr(o, 'default_effort', MAX_EFFORT_CHARS),
  };
}

/** One agent a host lists (`FleetAgentInfo`): every field bounded. */
function agentInfo(v: unknown): FleetAgentInfo {
  const o = obj(v, 'agent');
  return {
    id: str(o, 'id', MAX_AGENT_ID_CHARS),
    label: str(o, 'label', MAX_AGENT_LABEL_CHARS, true),
    default_model: optStr(o, 'default_model', MAX_MODEL_ID_CHARS),
    default_effort: optStr(o, 'default_effort', MAX_EFFORT_CHARS),
    models:
      o.models === undefined
        ? []
        : arr(o, 'models', MAX_AGENT_MODELS).map(modelInfo),
  };
}

/** One host's auto mode for an `mcp` device it pins (`McpAutoState`). */
function mcpAuto(v: unknown): McpAutoState {
  const o = obj(v, 'mcp_auto entry');
  return {
    device_id: str(o, 'device_id', 64),
    auto: oneOf(o, 'auto', MCP_AUTOS),
    until_ms: optUint(o, 'until_ms'),
  };
}

function deviceInfo(
  v: unknown,
  protocol: number,
  internal: boolean,
): DeviceInfo {
  const o = obj(v, 'info');
  const info: DeviceInfo = {
    name: str(o, 'name', 100),
    os: oneOf(o, 'os', ['macos', 'linux', 'windows', 'ios', 'android']),
    kind: oneOf(o, 'kind', kindsFor(protocol, internal)),
    app_version: str(o, 'app_version', 64),
    projects: arr(o, 'projects', 200).map((p) => {
      const po = obj(p, 'project');
      return { id: str(po, 'id', 128), name: str(po, 'name', 200) };
    }),
    accepts_remote: bool(o, 'accepts_remote'),
    max_mode: oneOf(o, 'max_mode', MODES),
    // A host older than the field sends none.
    agents:
      o.agents === undefined || o.agents === null
        ? []
        : arr(o, 'agents', MAX_AGENTS).map(agentInfo),
    // Protocol 6; older hosts send none.
    mcp_auto:
      protocol < V6 || o.mcp_auto === undefined || o.mcp_auto === null
        ? []
        : arr(o, 'mcp_auto', MAX_MCP_AUTO).map(mcpAuto),
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
  'mirror',
] as const;

const MIRROR_MODELS: readonly string[] = [...MIRROR_KEPT, ...MIRROR_RELAYED];

/** Only the kind is read; the event travels as the host signed it. */
function spaceEvent(v: unknown): RemoteSpaceEvent {
  const o = obj(v, 'event');
  const kind = oneOf(o, 'kind', EVENT_KINDS);
  // The cloud keeps a space's status (finished spaces go first at the cap).
  if (kind === 'status') {
    oneOf(o, 'status', ['running', 'idle', 'waiting', 'stopped', 'failed']);
  }
  // It decides what the cloud keeps (and under which key).
  if (kind === 'mirror') {
    const { model, id } = o;
    if (typeof model !== 'string' || !MIRROR_MODELS.includes(model)) {
      throw new BadMessage(
        codes.INVALID,
        `mirror model must be one of ${MIRROR_MODELS.join(', ')}`,
      );
    }
    if (
      typeof id !== 'string' ||
      id === '' ||
      id.length > MAX_MIRROR_ID_CHARS
    ) {
      throw new BadMessage(
        codes.INVALID,
        `mirror id must be a string of 1 to ${MAX_MIRROR_ID_CHARS} chars`,
      );
    }
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

/** `ExponentPushToken[…]` (or the newer `ExpoPushToken[…]`); '' removes. */
const PUSH_TOKEN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/;

function pushToken(o: Obj): string {
  const t = str(o, 'token', MAX_PUSH_TOKEN_CHARS, true);
  if (t !== '' && !PUSH_TOKEN.test(t)) throw bad('not an Expo push token');
  return t;
}

/**
 * One frame from a device, checked. `protocol`: the connection's, once its
 * hello was accepted (it decides which device kinds an `announce` may say).
 * `internal`: the cloud's own MCP device, in process (kind `mcp` only).
 * Throws [`BadMessage`].
 */
export function parseClient(
  raw: string,
  protocol = PROTOCOL_VERSION,
  internal = false,
): ClientMessage {
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
      const v = o.protocol;
      if (
        typeof v !== 'number' ||
        !Number.isInteger(v) ||
        v < MIN_PROTOCOL_VERSION ||
        v > PROTOCOL_VERSION
      ) {
        throw new BadMessage(
          codes.VERSION,
          `protocol ${MIN_PROTOCOL_VERSION} to ${PROTOCOL_VERSION} only`,
        );
      }
      return {
        type: 'hello',
        protocol: v,
        device_id: optStr(o, 'device_id', 64),
        public_key: str(o, 'public_key', 64),
        signature: str(o, 'signature', 128),
        info: deviceInfo(o.info, v, internal),
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
      return {
        type: 'announce',
        info: deviceInfo(o.info, protocol, internal),
      };
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
    case 'register_push':
      if (protocol < 4) break;
      return {
        type: 'register_push',
        provider: oneOf(o, 'provider', ['expo']),
        token: pushToken(o),
      };
    case 'delegate':
      if (protocol < 4) break;
      return { type: 'delegate', envelope: envelope(o.envelope) };
    case 'confirm':
      if (protocol < V6) break;
      return { type: 'confirm', envelope: envelope(o.envelope) };
    case 'confirm_resolved':
      if (protocol < V6) break;
      return { type: 'confirm_resolved', confirm_id: str(o, 'confirm_id') };
    default:
      break;
  }
  throw bad('unknown message type');
}

/** The `{device_id, envelope}` of `POST /v1/fleet/request`. */
export function parseHttpRequest(v: unknown): {
  device_id: string;
  envelope: SignedEnvelope;
} {
  const o = obj(v, 'body');
  return { device_id: str(o, 'device_id', 64), envelope: envelope(o.envelope) };
}

/** An origin's delegation: every field, all of it decides routing. */
export function peekDelegation(body: string): Delegation {
  const o = parseBody(body, 'delegation body');
  return {
    origin_device: str(o, 'origin_device', 64),
    delegate_device: str(o, 'delegate_device', 64),
    issued_at_ms: uint(o, 'issued_at_ms'),
    expires_at_ms: uint(o, 'expires_at_ms'),
    revoke: bool(o, 'revoke'),
  };
}

/** What the cloud reads from a signed body: routing fields, nothing else. */
export interface Routing {
  req_id: string;
  origin_device: string;
  target_device: string;
  /** The target's key as the origin pinned it. */
  target_key: string;
  op:
    | 'start_space'
    | 'send'
    | 'stop'
    | 'answer'
    | 'confirm'
    | 'set_mcp_auto'
    | AnySpaceOp
    | ArchiveOp;
  /**
   * The cloud space (`rs_` id) it acts on; '' for an op on no space
   * (`confirm`, `set_mcp_auto`) and for one on any of the target's own
   * spaces (`ANY_SPACE_OPS`), which the cloud doesn't track.
   */
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
  const kind = oneOf(op, 'op', [
    'start_space',
    'send',
    'stop',
    'answer',
    'confirm',
    'set_mcp_auto',
    ...ANY_SPACE_OPS,
    // Protocol 9: on the `rs_` space, routed like `stop`.
    ...ARCHIVE_OPS,
  ]);
  // Not read for routing, only bounded: the target checks them against
  // what it lists.
  if (kind === 'start_space' || kind === 'send') {
    optStr(op, 'agent', MAX_AGENT_ID_CHARS);
    optStr(op, 'model', MAX_MODEL_ID_CHARS);
    optStr(op, 'effort', MAX_EFFORT_CHARS);
  }
  if (kind === 'confirm') {
    str(op, 'confirm_id');
    bool(op, 'allow');
  }
  if (kind === 'set_mcp_auto') {
    str(op, 'mcp_device', 64);
    oneOf(op, 'auto', MCP_AUTOS);
    optUint(op, 'until_ms');
  }
  if (onAnySpace(kind)) anySpaceFields(op, kind);
  const onSpace =
    kind !== 'confirm' && kind !== 'set_mcp_auto' && !onAnySpace(kind);
  return {
    req_id: str(o, 'req_id'),
    origin_device: str(o, 'origin_device', 64),
    target_device: str(o, 'target_device', 64),
    target_key: str(o, 'target_key', 64),
    op: kind,
    space: onSpace ? str(op, 'space') : '',
    parent: kind === 'start_space' ? optStr(op, 'parent') : null,
    depth: kind === 'start_space' ? uint(op, 'depth') : 0,
    ask_id: kind === 'answer' ? str(op, 'ask_id') : null,
  };
}

/** An op on any space of the target: every field bounded, none routed. */
function anySpaceFields(op: Obj, kind: AnySpaceOp) {
  const id = (k: string) => str(op, k, MAX_ANY_SPACE_ID_CHARS);
  const text = (k: string) => chars(op, k, MAX_ANY_SPACE_TEXT_CHARS);
  switch (kind) {
    case 'list_spaces':
      optStr(op, 'project', 100);
      return;
    case 'read_space': {
      id('space');
      const n = optUint(op, 'messages');
      if (n !== null && n > MAX_READ_MESSAGES) {
        throw bad(`messages must be at most ${MAX_READ_MESSAGES}`);
      }
      return;
    }
    case 'ask_space':
      id('space');
      text('question');
      return;
    case 'send_to':
      id('space');
      text('message');
      return;
    case 'answer_space':
      id('space');
      str(op, 'ask');
      // As the MCP tools take them: ≤ 20 questions, ≤ 50 picks of ≤ 4000.
      for (const a of arr(op, 'answers', 20)) {
        if (!Array.isArray(a) || a.length > 50) {
          throw bad('answers must hold lists of at most 50');
        }
        for (const x of a) {
          if (typeof x !== 'string' || x.length > 4000) {
            throw bad('an answer must be a string of at most 4000 chars');
          }
        }
      }
      return;
    case 'merge_child':
      id('parent');
      id('child');
      return;
    case 'queued_message':
      id('space');
      str(op, 'message', MAX_ANY_SPACE_ID_CHARS);
      oneOf(op, 'action', QUEUED_ACTIONS);
      return;
  }
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

/** A host's confirm: every field, all of it is shown (and pushed). */
export function peekConfirm(body: string): RemoteConfirm {
  const o = parseBody(body, 'confirm body');
  return {
    confirm_id: str(o, 'confirm_id'),
    host_device: str(o, 'host_device', 64),
    mcp_device: str(o, 'mcp_device', 64),
    action: oneOf(o, 'action', ['start', 'send', 'approve_plan', 'merge']),
    mode: oneOf(o, 'mode', MODES),
    project_name: optChars(o, 'project_name', 200),
    space_name: optChars(o, 'space_name', 200),
    text: chars(o, 'text', CONFIRM_TEXT_MAX, true),
    expires_at_ms: uint(o, 'expires_at_ms'),
  };
}

/**
 * What a signature is for (`fleet_protocol::Domain`): each kind signs
 * `"theodore-fleet-<kind>-v3\0" ‖ bytes`, so one never verifies as another.
 */
export type Domain =
  'hello' | 'request' | 'event' | 'ask' | 'reply' | 'delegate' | 'confirm';

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
