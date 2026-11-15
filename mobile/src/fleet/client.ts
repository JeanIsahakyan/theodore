/**
 * The fleet client of this app: a CLIENT device, never a host
 * (docs/mobile.md). The TS twin of the desktop's origin core
 * (`crates/app/src/usecases/fleet_origin.rs`) and link
 * (`crates/fleet/src/link.rs`), writing `useFleetState`.
 *
 * ```text
 * start ─▶ session + org ─▶ WSS <cloud>/v1/fleet/ws (Bearer header | bearer.<token> subprotocol)
 *   challenge{nonce: 32 bytes} ─▶ hello{protocol 4, kind mobile|web, accepts_remote false,
 *                                       max_mode ask, projects [], spaces []}
 *   welcome ─▶ device id kept per org ─▶ reauth if the token changed meanwhile,
 *              register_push again, subscribe{space, since: last seq} again
 *   close 4001/4003, error{fatal code} ─▶ error state, no redial until start()
 *                                          (or a refreshed token)
 *   anything else ─▶ redial, 0.5 s doubling to 30 s, ±25 %
 * startSpace ─▶ target listed, hosts, pinned with the key listed now
 *   ─▶ seal{target_key: pin} ─▶ starting ─▶ reply opened with that pin ─▶ ok: subscribe
 *                                        └▶ refused (the cloud's): its code only
 * space_event / ask ─▶ opened with the host's pin (Event / Ask) ─▶ store   else dropped
 * space_gap ─▶ a gap line; dismiss ─▶ question gone; delegations ─▶ verified, kept
 * ```
 *
 * Following (delegation): when an origin has delegated to this device and
 * an ask (or event) for a space not tracked here verifies against a pinned
 * host, the space is followed: tracked with `startedHere: false` and
 * subscribed from 0. Everything shown of it is still checked against the
 * host's pin; a delegation only decides what to subscribe to.
 *
 * Heartbeat: a JS socket can't see pongs, so there's no silence timer after
 * the welcome. Native sends a ping frame every 15 s (keeps NAT and the
 * cloud's idle timer happy; a dead socket errors and closes); the
 * handshake must finish within 45 s. iOS closes the socket in the
 * background and redials on foreground.
 */
import { config } from '../config';
import type {
  ClientMessage,
  DeviceSummary,
  RemoteOp,
  RemoteSpaceEvent,
  ServerMessage,
  SignedEnvelope,
} from '../gen/fleet';
import type { AuthClient, Session } from '../auth/types';
import { wellFormedKey } from '../keys/ed25519';
import { fingerprint } from '../keys/fingerprint';
import { createKeyStore } from '../keys/store';
import { storageKey, type SecretStorage } from '../keys/storage-types';
import type { DeviceKey, KeyStore } from '../keys/types';
import { initialFleet, useFleetState } from '../state/fleet';
import { open, peek, seal, signHello } from './crypto';
import { pinStore, type Pin, type PinStore } from './pins';
import { defaultPlatform } from './platform';
import type { FleetPlatform, FleetSocket } from './platform-types';
import {
  ERROR_TEXT_MAX,
  LINES_KEPT,
  NAME_MAX,
  gapLine,
  hosts,
  isMode,
  lineOf,
  pinName,
  remoteStatus,
  safeCode,
  truncate,
  uiQuestions,
  validDeviceId,
} from './rules';
import type {
  FleetClient,
  FleetDeviceView,
  QuestionView,
  SpaceLine,
  SpaceView,
} from './types';

export const PROTOCOL_VERSION = 4;
export const MAX_FRAME_BYTES = 256 * 1024;

/** Cloud error codes that end the link for good (link.rs `FATAL_CODES`). */
export const FATAL_CODES = [
  'fleet.unauthorized',
  'fleet.no_org',
  'fleet.key_mismatch',
  'fleet.version',
  'fleet.too_many_devices',
  'fleet.removed',
] as const;
const FATAL_CLOSE = [4001, 4003];

export interface FleetTiming {
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Native ping frames. */
  pingEveryMs: number;
  /** From the dial to the welcome. */
  handshakeMs: number;
  /** send / stop / answer wait this long for the host's word. */
  replyWaitMs: number;
  /** startSpace waits this long, then returns the space still `starting`. */
  startWaitMs: number;
  /** A request's reply is still taken this long after it went out. */
  pendingTtlMs: number;
}

export const DEFAULT_TIMING: FleetTiming = {
  backoffBaseMs: 500,
  backoffMaxMs: 30_000,
  pingEveryMs: 15_000,
  handshakeMs: 45_000,
  replyWaitMs: 15_000,
  startWaitMs: 30_000,
  pendingTtlMs: 150_000,
};

export interface FleetDeps {
  platform: FleetPlatform;
  /** Pins and the device id per org (defaults to the platform's). */
  storage: SecretStorage;
  cloudUrl: string;
  fetch: typeof fetch;
  timing: FleetTiming;
  now: () => number;
  /** In [0, 1): backoff jitter. */
  random: () => number;
}

/** A request that didn't succeed; `code` is a refusal code when there is one. */
export class FleetError extends Error {
  constructor(
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'FleetError';
  }
}

type Answer =
  | { kind: 'ok'; value: unknown }
  | { kind: 'err'; code: string; message: string }
  | { kind: 'refused'; code: string }
  | { kind: 'timeout' };

/** A refusal as the UI may show it: a verified target's words, the cloud's code alone. */
function answerError(a: Answer): FleetError | null {
  switch (a.kind) {
    case 'ok':
      return null;
    case 'err':
      return new FleetError(
        a.message
          ? `the other device refused: ${a.code}: ${a.message}`
          : `the other device refused: ${a.code}`,
        a.code,
      );
    case 'refused':
      return new FleetError(`refused by the cloud: ${a.code}`, a.code);
    case 'timeout':
      return new FleetError("the other device didn't answer in time");
  }
}

interface Pending {
  space: string;
  start: boolean;
  target: string;
  targetKey: string;
  settle: (a: Answer) => void;
  expiry: ReturnType<typeof setTimeout>;
}

interface Tracked {
  view: SpaceView;
  lines: SpaceLine[];
  lastSeq: number;
  startedName: string | null;
  /** Subscribed (after a verified ok start, or followed). */
  subscribed: boolean;
}

interface Link {
  id: number;
  socket: FleetSocket;
  org: string;
  /** The token the cloud has (the dial's, then the last reauth). */
  token: string;
  challenged: boolean;
  welcomed: boolean;
  handshake: ReturnType<typeof setTimeout> | null;
  ping: ReturnType<typeof setInterval> | null;
  /** Frames are handled one at a time, in order (handlers await storage). */
  inbox: Promise<void>;
}

const deviceIdKey = (org: string) =>
  storageKey('theodore.fleet.device_id', org);
const wsUrl = (cloud: string) =>
  `${cloud.replace(/\/+$/, '').replace(/^http/, 'ws')}/v1/fleet/ws`;
const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

export function createFleetClient(
  auth: AuthClient,
  keys: KeyStore = createKeyStore(),
  overrides: Partial<FleetDeps> = {},
): FleetClient {
  const platform = overrides.platform ?? defaultPlatform();
  const deps: FleetDeps = {
    platform,
    storage: overrides.storage ?? platform.storage,
    cloudUrl: overrides.cloudUrl ?? config.cloudUrl,
    fetch: overrides.fetch ?? ((...a) => fetch(...a)),
    timing: overrides.timing ?? DEFAULT_TIMING,
    now: overrides.now ?? Date.now,
    random: overrides.random ?? Math.random,
  };
  const t = deps.timing;
  const pins: PinStore = pinStore(deps.storage);
  const set = useFleetState.setState;

  // ── state ───────────────────────────────────────────────────────────────
  let wanted = false;
  let fatal: { token: string } | null = null;
  let link: Link | null = null;
  let linkSeq = 0;
  let dialing = false;
  /** Bumped by sign-out and org switch: a dial under way for the old one is dropped. */
  let epoch = 0;
  let attempt = 0;
  let redial: ReturnType<typeof setTimeout> | null = null;
  let background = false;
  let session: Session | null = null;
  let me: string | null = null;
  let devices: DeviceSummary[] = [];
  let rawDelegations: SignedEnvelope[] = [];
  /** Origins that delegated to this device → expiry (0: none). */
  let delegators = new Map<string, number>();
  let push: { token: string } | null = null;
  const pending = new Map<string, Pending>();
  const tracked = new Map<string, Tracked>();
  const questions = new Map<string, { view: QuestionView; host: string }>();

  // ── publishing ──────────────────────────────────────────────────────────
  const publishSpaces = () =>
    set({ spaces: [...tracked.values()].map((x) => ({ ...x.view })) });
  const publishLines = (space: string) => {
    const x = tracked.get(space);
    if (x) set((s) => ({ lines: { ...s.lines, [space]: [...x.lines] } }));
  };
  const publishQuestions = () =>
    set({ questions: [...questions.values()].map((q) => q.view) });
  const publishDevices = async () => {
    const pinned = new Map((await pins.list()).map((p) => [p.deviceId, p]));
    const views: FleetDeviceView[] = devices.map((d) => {
      const pin = pinned.get(d.device_id);
      const trusted = !!pin && pin.publicKey === d.public_key;
      return {
        deviceId: d.device_id,
        name: trusted ? pin.name : truncate(String(d.info?.name ?? ''), 100),
        kind: String(d.info?.kind ?? ''),
        os: String(d.info?.os ?? ''),
        online: d.online === true,
        acceptsRemote: d.info?.accepts_remote === true,
        maxMode: isMode(d.info?.max_mode) ? d.info.max_mode : 'ask',
        projects: Array.isArray(d.info?.projects)
          ? d.info.projects.map((p) => ({ id: p.id, name: p.name }))
          : [],
        publicKey: d.public_key,
        fingerprint: fingerprint(d.public_key),
        trusted,
        thisDevice: d.device_id === me,
      };
    });
    set({ devices: views });
  };
  const setConnection = (
    connection: 'off' | 'connecting' | 'connected' | 'error',
    error: string | null = null,
  ) => set({ connection, error, deviceId: me });

  /** Sign-out or org switch: nothing of the old fleet stays on screen. */
  const forgetFleet = () => {
    for (const p of pending.values()) {
      clearTimeout(p.expiry);
      p.settle({ kind: 'timeout' });
    }
    pending.clear();
    tracked.clear();
    questions.clear();
    devices = [];
    rawDelegations = [];
    delegators = new Map();
    me = null;
    set({ ...initialFleet, fingerprint: useFleetState.getState().fingerprint });
  };

  // ── the link ────────────────────────────────────────────────────────────
  const sendMsg = (msg: ClientMessage): boolean => {
    if (!link?.welcomed) return false;
    const text = JSON.stringify(msg);
    if (text.length > MAX_FRAME_BYTES) return false;
    try {
      link.socket.send(text);
      return true;
    } catch {
      lost(link);
      return false;
    }
  };

  const clearLinkTimers = (l: Link) => {
    if (l.handshake) clearTimeout(l.handshake);
    if (l.ping) clearInterval(l.ping);
    l.handshake = null;
    l.ping = null;
  };

  /** Ends the current link without a redial (stop, background, org switch). */
  const closeLink = () => {
    const l = link;
    link = null;
    if (redial) clearTimeout(redial);
    redial = null;
    if (!l) return;
    clearLinkTimers(l);
    try {
      l.socket.close(1000, 'closing');
    } catch {
      // already gone
    }
  };

  const lost = (l: Link) => {
    if (link !== l) return;
    closeLink();
    setConnection('connecting');
    scheduleRedial();
  };

  const toFatal = async (l: Link, code: string) => {
    if (link !== l) return;
    closeLink();
    fatal = { token: l.token };
    if (code === 'fleet.removed') {
      // Gone from the cloud: the next link joins as a new device.
      await deps.storage.remove(deviceIdKey(l.org)).catch(() => {});
    }
    setConnection('error', fatalText(code));
  };

  const scheduleRedial = () => {
    if (
      !wanted ||
      fatal ||
      redial ||
      (background && platform.closeInBackground)
    )
      return;
    const exp = Math.min(t.backoffMaxMs, t.backoffBaseMs * 2 ** attempt);
    const delay = exp * (0.75 + deps.random() * 0.5);
    attempt = Math.min(attempt + 1, 30);
    redial = setTimeout(() => {
      redial = null;
      void connect();
    }, delay);
  };

  const connect = async (): Promise<void> => {
    if (!wanted || fatal || link || dialing) return;
    if (background && platform.closeInBackground) return;
    dialing = true;
    const mine = epoch;
    try {
      const s = await auth.current();
      if (mine !== epoch) return;
      session = s;
      if (!s) {
        setConnection('off');
        return;
      }
      if (!s.organizationId) {
        setConnection(
          'error',
          'choose an organization to use the fleet (fleet.no_org)',
        );
        return;
      }
      const token = await auth.accessToken();
      if (!token) {
        setConnection('off');
        return;
      }
      const key = await keys.deviceKey();
      set({ fingerprint: fingerprint(key.publicKey) });
      const stored = await deps.storage.get(deviceIdKey(s.organizationId));
      if (mine !== epoch || !wanted || fatal || link) return;
      if (background && platform.closeInBackground) return;
      setConnection('connecting');
      const socket = platform.openSocket(wsUrl(deps.cloudUrl), token);
      const l: Link = {
        id: ++linkSeq,
        socket,
        org: s.organizationId,
        token,
        challenged: false,
        welcomed: false,
        handshake: null,
        ping: null,
        inbox: Promise.resolve(),
      };
      link = l;
      l.handshake = setTimeout(() => lost(l), t.handshakeMs);
      socket.onopen = () => {
        if (link !== l || !socket.ping) return;
        l.ping = setInterval(() => {
          try {
            socket.ping?.();
          } catch {
            lost(l);
          }
        }, t.pingEveryMs);
      };
      socket.onerror = () => lost(l);
      socket.onclose = (ev) => {
        if (link !== l) return;
        const code = ev?.code ?? 1006;
        if (FATAL_CLOSE.includes(code)) {
          const reason = ev?.reason ?? '';
          void toFatal(
            l,
            (FATAL_CODES as readonly string[]).includes(reason)
              ? reason
              : 'fleet.unauthorized',
          );
        } else {
          lost(l);
        }
      };
      socket.onmessage = (ev) => {
        if (link !== l || typeof ev?.data !== 'string') return;
        if (ev.data.length > MAX_FRAME_BYTES) return;
        let msg: unknown;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (isObj(msg) && typeof msg.type === 'string') {
          const frame = msg as ServerMessage;
          l.inbox = l.inbox
            .then(() =>
              link === l
                ? onFrame(l, frame, key, validDeviceId(stored) ? stored : null)
                : undefined,
            )
            .catch(() => {});
        }
      };
    } catch (e) {
      setConnection(
        'error',
        e instanceof Error ? e.message : 'the fleet failed to start',
      );
    } finally {
      dialing = false;
      if (mine !== epoch) void connect();
    }
  };

  const onFrame = async (
    l: Link,
    msg: ServerMessage,
    key: DeviceKey,
    storedId: string | null,
  ) => {
    if (msg.type === 'error') {
      if ((FATAL_CODES as readonly string[]).includes(msg.code)) {
        return toFatal(l, msg.code);
      }
      // Before the welcome: a protocol slip, redial. After: informational.
      if (!l.welcomed) lost(l);
      return;
    }
    if (msg.type === 'challenge') {
      // One challenge per socket: a second is the cloud fishing for a signature.
      if (l.challenged) return lost(l);
      l.challenged = true;
      const signature = await signHello(key, String(msg.nonce));
      if (link !== l) return;
      if (!signature) return lost(l);
      const hello: ClientMessage = {
        type: 'hello',
        protocol: PROTOCOL_VERSION,
        device_id: storedId,
        public_key: key.publicKey,
        signature,
        info: {
          name: platform.name,
          os: platform.os,
          kind: platform.kind,
          app_version: platform.appVersion,
          projects: [],
          accepts_remote: false,
          max_mode: 'ask',
        },
        spaces: [],
      };
      try {
        l.socket.send(JSON.stringify(hello));
      } catch {
        lost(l);
      }
      return;
    }
    if (msg.type === 'welcome') {
      if (l.welcomed) return;
      if (!l.challenged || !validDeviceId(msg.device_id)) return lost(l);
      l.welcomed = true;
      if (l.handshake) clearTimeout(l.handshake);
      l.handshake = null;
      attempt = 0;
      me = msg.device_id;
      await deps.storage.set(deviceIdKey(l.org), msg.device_id).catch(() => {});
      if (link !== l) return;
      setConnection('connected');
      // What changed during the handshake, then what belongs to every connection.
      const latest = session?.accessToken;
      if (latest && latest !== l.token) {
        l.token = latest;
        sendMsg({ type: 'reauth', access_token: latest });
      }
      if (push)
        sendMsg({ type: 'register_push', provider: 'expo', token: push.token });
      for (const [space, x] of tracked) {
        if (x.subscribed)
          sendMsg({ type: 'subscribe', space, since: x.lastSeq });
      }
      void publishDevices();
      return;
    }
    if (!l.welcomed) return;
    switch (msg.type) {
      case 'devices':
        devices = Array.isArray(msg.devices)
          ? msg.devices.filter(
              (d) =>
                validDeviceId(d?.device_id) && typeof d.public_key === 'string',
            )
          : [];
        await verifyDelegations();
        return publishDevices();
      case 'reply':
        return onReply(msg.envelope);
      case 'refused':
        return answered(String(msg.req_id), {
          kind: 'refused',
          code: safeCode(msg.code),
        });
      case 'space_event':
        return onEvent(msg.envelope);
      case 'space_gap':
        return onGap(msg.space, msg.from, msg.to);
      case 'ask':
        return onAsk(msg.envelope);
      case 'dismiss':
        if (questions.delete(String(msg.ask_id))) publishQuestions();
        return;
      case 'delegations':
        rawDelegations = Array.isArray(msg.list) ? msg.list : [];
        return verifyDelegations();
      default:
        // `request` / `claim_result`: never a target, nothing to run.
        return;
    }
  };

  // ── inbound ─────────────────────────────────────────────────────────────
  const onReply = (envelope: SignedEnvelope) => {
    const peeked = isObj(envelope) ? peek(envelope) : null;
    const reqId = peeked?.req_id;
    if (typeof reqId !== 'string') return;
    const p = pending.get(reqId);
    if (!p || envelope.device_id !== p.target) return;
    const body = open(envelope, p.targetKey, 'reply');
    if (!body || body.req_id !== reqId || body.origin_device !== me) return;
    const o = body.outcome as Record<string, unknown> | undefined;
    if (o?.outcome === 'ok') {
      answered(reqId, { kind: 'ok', value: o.value });
    } else if (o?.outcome === 'err') {
      answered(reqId, {
        kind: 'err',
        code: safeCode(o.code),
        message: truncate(
          typeof o.message === 'string' ? o.message.trim() : '',
          ERROR_TEXT_MAX,
        ),
      });
    }
  };

  const answered = (reqId: string, a: Answer) => {
    const p = pending.get(reqId);
    if (!p) return;
    pending.delete(reqId);
    clearTimeout(p.expiry);
    const x = p.start ? tracked.get(p.space) : undefined;
    if (x) {
      if (a.kind === 'ok') {
        const v = isObj(a.value) ? a.value : {};
        if (typeof v.name === 'string')
          x.view.name = truncate(v.name, NAME_MAX);
        if (typeof v.branch === 'string')
          x.view.branch = truncate(v.branch, NAME_MAX);
        if (x.view.status === 'starting') x.view.status = 'running';
        x.view.error = null;
        // Before the host's signed ok the cloud doesn't know the space.
        x.subscribed = true;
        sendMsg({ type: 'subscribe', space: p.space, since: x.lastSeq });
      } else {
        x.view.status = 'failed';
        x.view.error = answerError(a)?.message ?? null;
      }
      publishSpaces();
    }
    p.settle(a);
  };

  const follow = (
    space: string,
    host: string,
    pin: Pin,
    status: SpaceView['status'],
  ) => {
    const x: Tracked = {
      view: {
        space,
        hostDevice: host,
        hostName: pin.name,
        originDevice: '',
        projectName: '',
        name: '',
        branch: '',
        status,
        mode: 'ask',
        lastReply: null,
        question: null,
        startedHere: false,
        error: null,
      },
      lines: [],
      lastSeq: 0,
      startedName: null,
      subscribed: true,
    };
    tracked.set(space, x);
    sendMsg({ type: 'subscribe', space, since: 0 });
    publishSpaces();
    return x;
  };

  const delegated = () => {
    const now = deps.now();
    return [...delegators.values()].some((exp) => exp === 0 || exp > now);
  };

  const onEvent = async (envelope: SignedEnvelope) => {
    const peeked = isObj(envelope) ? peek(envelope) : null;
    const space = peeked?.space;
    if (typeof space !== 'string') return;
    const x = tracked.get(space);
    const host = x ? x.view.hostDevice : envelope.device_id;
    if (envelope.device_id !== host) return;
    const pin = await pins.get(host);
    if (!pin) return;
    const body = open(envelope, pin.publicKey, 'event');
    if (!body || body.space !== space || typeof body.seq !== 'number') return;
    if (!x) {
      // A space not tracked here: followed if an origin delegated to us;
      // its history (this event included) comes with the subscription.
      if (delegated() && !tracked.has(space))
        follow(space, host, pin, 'running');
      return;
    }
    applyEvent(x, body.seq, body.event);
  };

  const pushLine = (x: Tracked, line: SpaceLine) => {
    x.lines.push(line);
    if (x.lines.length > LINES_KEPT)
      x.lines.splice(0, x.lines.length - LINES_KEPT);
  };

  const applyEvent = (x: Tracked, seq: number, ev: RemoteSpaceEvent) => {
    if (seq <= x.lastSeq || !isObj(ev)) return;
    const line = lineOf(seq, ev);
    if (!line) return;
    x.lastSeq = seq;
    const v = x.view;
    const e = ev as Record<string, unknown>;
    switch (ev.kind) {
      case 'started':
        // Host stays what was asked for (or what asked here), whatever it says.
        x.startedName =
          typeof e.name === 'string' ? truncate(e.name, NAME_MAX) : '';
        v.name = x.startedName;
        v.branch =
          typeof e.branch === 'string' ? truncate(e.branch, NAME_MAX) : '';
        v.projectName =
          typeof e.project_name === 'string'
            ? truncate(e.project_name, NAME_MAX)
            : v.projectName;
        if (isMode(e.mode)) v.mode = e.mode;
        if (!v.startedHere && validDeviceId(e.origin_device))
          v.originDevice = e.origin_device;
        if (v.status === 'starting') v.status = 'running';
        break;
      case 'status': {
        const s = remoteStatus(e.status);
        if (s) v.status = s;
        break;
      }
      case 'reply':
        v.lastReply = typeof e.text === 'string' ? truncate(e.text, 8000) : '';
        break;
      case 'question':
        if (typeof e.ask_id === 'string') {
          v.question = {
            askId: e.ask_id,
            space: v.space,
            from: x.startedName
              ? `${v.hostName} · ${x.startedName}`
              : v.hostName,
            questions: uiQuestions(e.questions),
          };
        }
        break;
      case 'question_cleared':
        if (v.question?.askId === e.ask_id) v.question = null;
        break;
      default:
        break;
    }
    pushLine(x, line);
    publishSpaces();
    publishLines(v.space);
  };

  const onGap = (space: unknown, from: unknown, to: unknown) => {
    if (
      typeof space !== 'string' ||
      typeof from !== 'number' ||
      typeof to !== 'number'
    )
      return;
    const x = tracked.get(space);
    if (!x) return;
    const line = gapLine(from, to);
    if (x.lines.some((l) => l.kind === 'gap' && l.text === line.text)) return;
    pushLine(x, line);
    publishLines(space);
  };

  const onAsk = async (envelope: SignedEnvelope) => {
    if (!isObj(envelope) || typeof envelope.device_id !== 'string') return;
    const pin = await pins.get(envelope.device_id);
    if (!pin) return;
    const ask = open(envelope, pin.publicKey, 'ask');
    if (!ask || typeof ask.ask_id !== 'string' || typeof ask.space !== 'string')
      return;
    let x = tracked.get(ask.space);
    if (x && x.view.hostDevice !== ask.host_device) return;
    if (!x && delegated())
      x = follow(ask.space, ask.host_device, pin, 'waiting');
    // Named from the pin and the signed `started`, never the ask's own `from`.
    const from = x?.startedName ? `${pin.name} · ${x.startedName}` : pin.name;
    questions.set(ask.ask_id, {
      view: {
        askId: ask.ask_id,
        space: ask.space,
        from,
        questions: uiQuestions(ask.questions),
      },
      host: ask.host_device,
    });
    publishQuestions();
  };

  /** Delegations to this device, each opened with its origin's key. */
  const verifyDelegations = async () => {
    const next = new Map<string, number>();
    for (const env of rawDelegations) {
      if (!isObj(env) || typeof env.device_id !== 'string') continue;
      const pin = await pins.get(env.device_id);
      const key =
        pin?.publicKey ??
        devices.find((d) => d.device_id === env.device_id)?.public_key;
      if (!key) continue;
      const d = open(env, key, 'delegate');
      if (!d || d.delegate_device !== me || d.revoke) continue;
      const exp = typeof d.expires_at_ms === 'number' ? d.expires_at_ms : 0;
      if (exp !== 0 && exp <= deps.now()) continue;
      next.set(d.origin_device, exp);
    }
    delegators = next;
  };

  // ── outbound ────────────────────────────────────────────────────────────
  const ready = (): string => {
    if (!me || !link?.welcomed) {
      throw new FleetError('not connected to the fleet');
    }
    return me;
  };

  /** Signs `op` for a pinned `target` and sends it; resolves with its answer. */
  const request = async (
    target: string,
    op: RemoteOp,
    start: boolean,
  ): Promise<{ answer: Promise<Answer> }> => {
    const origin = ready();
    const pin = await pins.get(target);
    if (!pin) {
      throw new FleetError(
        `device ${target} isn't trusted on this device: trust it in Devices first`,
      );
    }
    const key = await keys.deviceKey();
    const reqId = `req_${platform.randomUUID()}`;
    const envelope = await seal(
      {
        req_id: reqId,
        origin_device: origin,
        target_device: target,
        target_key: pin.publicKey,
        issued_at_ms: deps.now(),
        op,
      },
      key,
    );
    let settle!: (a: Answer) => void;
    const answer = new Promise<Answer>((r) => (settle = r));
    pending.set(reqId, {
      space: op.space,
      start,
      target,
      targetKey: pin.publicKey,
      settle,
      expiry: setTimeout(() => pending.delete(reqId), t.pendingTtlMs),
    });
    if (!sendMsg({ type: 'request', envelope })) {
      clearTimeout(pending.get(reqId)!.expiry);
      pending.delete(reqId);
      throw new FleetError(
        'not connected to the fleet, or the request is too large',
      );
    }
    return { answer };
  };

  const within = (answer: Promise<Answer>, ms: number): Promise<Answer> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ kind: 'timeout' }), ms);
      void answer.then((a) => {
        clearTimeout(timer);
        resolve(a);
      });
    });

  const hostOf = (space: string): string => {
    const x = tracked.get(space);
    if (x) return x.view.hostDevice;
    for (const q of questions.values())
      if (q.view.space === space) return q.host;
    throw new FleetError(`no fleet space ${space} here`);
  };

  /** A send, stop or answer: the host's verified ok within the wait, or throws. */
  const steer = async (space: string, op: RemoteOp) => {
    const { answer } = await request(hostOf(space), op, false);
    const a = await within(answer, t.replyWaitMs);
    const err = answerError(a);
    if (err) throw err;
  };

  const client: FleetClient = {
    async start() {
      wanted = true;
      fatal = null;
      attempt = 0;
      await connect();
    },

    stop() {
      wanted = false;
      closeLink();
      setConnection('off');
    },

    async startSpace(req) {
      const origin = ready();
      const goal = req.goal.trim();
      if (!goal) throw new FleetError('say what the space should do');
      const target = devices.find((d) => d.device_id === req.deviceId);
      if (!target)
        throw new FleetError(`device ${req.deviceId} isn't in the fleet`);
      if (!hosts(target.info.kind)) {
        throw new FleetError('only a computer can run spaces');
      }
      const pin = await pins.get(target.device_id);
      if (!pin) {
        throw new FleetError(
          `device ${target.device_id} isn't trusted on this device: trust it in Devices first`,
        );
      }
      // Only with the key it had when trusted: its replies and events are
      // checked against it.
      if (pin.publicKey !== target.public_key) {
        throw new FleetError(
          `${pin.name}'s key changed since it was trusted: compare its fingerprint and trust it again`,
        );
      }
      const space = `rs_${platform.randomUUID().replace(/-/g, '')}`;
      const x: Tracked = {
        view: {
          space,
          hostDevice: target.device_id,
          hostName: pin.name,
          originDevice: origin,
          // The listing's project name is unsigned: the id until `started`.
          projectName: req.projectId,
          name: '',
          branch: '',
          status: 'starting',
          mode: req.mode,
          lastReply: null,
          question: null,
          startedHere: true,
          error: null,
        },
        lines: [],
        lastSeq: 0,
        startedName: null,
        subscribed: false,
      };
      tracked.set(space, x);
      publishSpaces();
      let answer: Promise<Answer>;
      try {
        ({ answer } = await request(
          target.device_id,
          {
            op: 'start_space',
            space,
            project_id: req.projectId,
            goal,
            mode: req.mode,
            depth: 0,
          },
          true,
        ));
      } catch (e) {
        tracked.delete(space);
        publishSpaces();
        throw e;
      }
      const a = await within(answer, t.startWaitMs);
      // A start the host is slow to answer stays `starting`; its reply
      // still lands while the request is pending.
      if (a.kind !== 'ok' && a.kind !== 'timeout') throw answerError(a)!;
      return { ...(tracked.get(space)?.view ?? x.view) };
    },

    async send(space, text) {
      if (!text.trim()) throw new FleetError('empty message');
      const x = tracked.get(space);
      const before = x?.view.status;
      // Running from now: the last turn's idle must not linger.
      if (x) {
        x.view.status = 'running';
        publishSpaces();
      }
      try {
        await steer(space, { op: 'send', space, text, mode: null });
      } catch (e) {
        if (x && before && x.view.status === 'running') {
          x.view.status = before;
          publishSpaces();
        }
        throw e;
      }
    },

    async stopSpace(space) {
      await steer(space, { op: 'stop', space });
    },

    async answer(space, askId, answers) {
      await steer(space, { op: 'answer', space, ask_id: askId, answers });
      if (questions.delete(askId)) publishQuestions();
    },

    async trust(deviceId, publicKey) {
      const listed = devices.find((d) => d.device_id === deviceId);
      if (!listed)
        throw new FleetError(
          `device ${deviceId} isn't in this organization's fleet`,
        );
      if (listed.public_key !== publicKey) {
        throw new FleetError(
          "that device's key changed since you compared its fingerprint: compare it again",
        );
      }
      if (!wellFormedKey(publicKey))
        throw new FleetError("that device's key is malformed");
      await pins.put({
        deviceId,
        publicKey,
        name: pinName(String(listed.info?.name ?? '')),
      });
      await verifyDelegations();
      await publishDevices();
    },

    async untrust(deviceId) {
      await pins.remove(deviceId);
      await verifyDelegations();
      await publishDevices();
    },

    async lines(space) {
      return [...(tracked.get(space)?.lines ?? [])];
    },

    async registerPush(token) {
      push = { token: token ?? '' };
      sendMsg({ type: 'register_push', provider: 'expo', token: push.token });
    },

    async answerOverHttp(space, askId, answers, hostDevice) {
      const s = await auth.current();
      const token = await auth.accessToken();
      if (!s || !token) throw new FleetError('not signed in');
      if (!s.organizationId) throw new FleetError('no organization chosen');
      const origin =
        me ?? (await deps.storage.get(deviceIdKey(s.organizationId)));
      if (!validDeviceId(origin)) {
        throw new FleetError(
          'this device has not joined the fleet yet: open the app once',
        );
      }
      const pin = await pins.get(hostDevice);
      if (!pin)
        throw new FleetError(
          `device ${hostDevice} isn't trusted on this device`,
        );
      const key = await keys.deviceKey();
      const envelope = await seal(
        {
          req_id: `req_${platform.randomUUID()}`,
          origin_device: origin,
          target_device: hostDevice,
          target_key: pin.publicKey,
          issued_at_ms: deps.now(),
          op: { op: 'answer', space, ask_id: askId, answers },
        },
        key,
      );
      const res = await deps.fetch(
        `${deps.cloudUrl.replace(/\/+$/, '')}/v1/fleet/request`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ device_id: origin, envelope }),
        },
      );
      const json: unknown = await res.json().catch(() => null);
      const body = isObj(json) ? json : {};
      const refusal = isObj(body.refused)
        ? body.refused
        : isObj(body.error)
          ? body.error
          : null;
      if (!res.ok || refusal || body.accepted === false) {
        const code = safeCode(refusal?.code ?? body.code);
        throw new FleetError(`refused by the cloud: ${code}`, code);
      }
      if (questions.delete(askId)) publishQuestions();
    },
  };

  // ── account and app lifecycle ───────────────────────────────────────────
  auth.onChange((s) => {
    const before = session;
    session = s;
    if (!s) {
      // Signed out: stop pushes to this phone first (the socket is still
      // authenticated), then the link goes, and nothing of that fleet stays
      // shown.
      if (push?.token)
        sendMsg({ type: 'register_push', provider: 'expo', token: '' });
      push = null;
      epoch++;
      closeLink();
      forgetFleet();
      return;
    }
    if (!wanted) return;
    if (before && before.organizationId !== s.organizationId) {
      epoch++;
      closeLink();
      forgetFleet();
      fatal = null;
      attempt = 0;
      void connect();
      return;
    }
    if (fatal) {
      // A refreshed token lifts a fatal refusal (once per new token).
      if (s.accessToken !== fatal.token) {
        fatal = null;
        attempt = 0;
        void connect();
      }
      return;
    }
    if (!link) {
      void connect();
      return;
    }
    if (link.welcomed && link.token !== s.accessToken) {
      link.token = s.accessToken;
      sendMsg({ type: 'reauth', access_token: s.accessToken });
    }
    // Not welcomed yet: the welcome sends the latest token (`session`).
  });

  platform.onActive((active) => {
    background = !active;
    if (!active) {
      if (platform.closeInBackground && link) {
        closeLink();
        setConnection('off');
      }
      return;
    }
    if (!wanted || fatal || link) return;
    if (redial) clearTimeout(redial);
    redial = null;
    attempt = 0;
    void connect();
  });

  return client;
}

function fatalText(code: string): string {
  switch (code) {
    case 'fleet.unauthorized':
      return 'the cloud refused the session: sign in again (fleet.unauthorized)';
    case 'fleet.no_org':
      return 'choose an organization to use the fleet (fleet.no_org)';
    case 'fleet.key_mismatch':
      return "this device's key isn't the one the cloud has for it (fleet.key_mismatch)";
    case 'fleet.version':
      return 'this app is too old for the fleet: update it (fleet.version)';
    case 'fleet.too_many_devices':
      return 'too many devices on this account: remove one on a computer (fleet.too_many_devices)';
    case 'fleet.removed':
      return 'another of your devices removed this one from the fleet (fleet.removed)';
    default:
      return `the fleet refused this device (${safeCode(code)})`;
  }
}
