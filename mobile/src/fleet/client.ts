/**
 * The fleet client of this app: a CLIENT device, never a host
 * (docs/mobile.md). The TS twin of the desktop's origin core
 * (`crates/app/src/usecases/fleet_origin.rs`) and link
 * (`crates/fleet/src/link.rs`), writing `useFleetState`.
 *
 * ```text
 * start ─▶ session + org ─▶ WSS <cloud>/v1/fleet/ws (Bearer header | bearer.<token> subprotocol)
 *   challenge{nonce: 32 bytes} ─▶ hello{protocol 6, kind mobile|web, accepts_remote false,
 *                                       max_mode ask, projects [], spaces []}
 *   welcome ─▶ device id kept per org ─▶ reauth if the token changed meanwhile,
 *              register_push again, subscribe{space, since: last seq} again
 *   close 4001/4003, error{fatal code} ─▶ error state, no redial until start()
 *                                          (or a refreshed token)
 *   close 4000 (another connection of this device took over)
 *        ─▶ that one is a client of this JS context ─▶ this one goes quiet for good
 *        └▶ else (another tab, window) ─▶ "connected elsewhere", no redial until
 *           the app comes to the foreground / the tab is shown, or start()
 *   anything else ─▶ redial, 0.5 s doubling to 30 s, ±25 %
 * startSpace ─▶ target listed, hosts, pinned with the key listed now
 *   ─▶ seal{target_key: pin} ─▶ starting ─▶ reply opened with that pin ─▶ ok: subscribe
 *                                        └▶ refused (the cloud's): its code only
 * space_event / ask ─▶ opened with the host's pin (Event / Ask) ─▶ store   else dropped
 *   mirror{model, id, data} ─▶ the space's mirror (src/fleet/mirror.ts); its
 *   space row names the space and says its status, mode, question
 * space_gap ─▶ a gap line; dismiss ─▶ question gone; delegations ─▶ verified, kept
 * confirm ─▶ opened with the host's pin (Confirm), signer = host_device, not
 *            expired ─▶ kept by confirm_id until confirm_dismissed, its
 *            expiry, an answer from here, or the next welcome (the cloud
 *            sends the waiting ones again)
 * ```
 *
 * Kept across restarts (src/fleet/saved.ts), per account and organization:
 *
 * ```text
 * connect ─▶ session ─▶ saved set of <user>.<org>, written for this org's device id
 *   ─▶ listed at once (last known status), before the socket opens
 * welcome ─▶ started here: subscribe{since: last seq} (with the rest)
 * delegations ─▶ followed: its origin still delegates here ─▶ subscribe{since}
 *                          else ─▶ dropped
 * a change ─▶ saved within a second; the app going to the background ─▶ now
 * sign-out ─▶ the set is removed; org or account switch ─▶ kept, another listed
 *   (`forgetSaved` removes an account's sets once it left this device)
 * ```
 *
 * Archiving (docs/mobile.md "Archive"): `archiveSpace` signs `archive_space`
 * to the host like a stop. The host's ok marks the tracked space `archived`:
 * it stays tracked (lines, mirror, subscription, saved record) but leaves
 * the published list; `unarchiveSpace` clears the mark at once (Undo) and
 * the host's next row sets the status. A mirrored row saying `archived`
 * (archived on the computer) hides it the same way; any other status
 * shows it again.
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
  BlobRef,
  ClientMessage,
  DeviceSummary,
  RemoteOp,
  RemoteSpaceEvent,
  ServerMessage,
  SignedEnvelope,
} from '../gen/fleet';
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_PATH_CHARS,
  MAX_READ_FILE_BYTES,
  isBlobRef,
  openBlob,
  randomBytes,
  sealBlob,
  validateBlobRef,
} from './blob';
import { createBlobStore, type BlobStore } from './blob-store';
import { FleetError } from './errors';
import type { AuthClient, Session } from '../auth/types';
import { wellFormedKey } from '../keys/ed25519';
import { fingerprint } from '../keys/fingerprint';
import { createKeyStore } from '../keys/store';
import { storageKey, type SecretStorage } from '../keys/storage-types';
import type { DeviceKey, KeyStore } from '../keys/types';
import { initialFleet, useFleetState } from '../state/fleet';
import { log, track } from '../telemetry/log';
import { open, peek, seal, signHello } from './crypto';
import type { DataStorage } from './data';
import {
  applyMirror,
  emptyMirror,
  latestReply,
  mirrorStatus,
  mirrorTitle,
  type SpaceMirror,
} from './mirror';
import { pinStore, type Pin, type PinStore } from './pins';
import { SAVED_LINES, savedScope, savedSpaces, type SavedSpace } from './saved';
import { defaultPlatform } from './platform';
import type { FleetPlatform, FleetSocket } from './platform-types';
import {
  ERROR_TEXT_MAX,
  LINES_KEPT,
  NAME_MAX,
  confirmOf,
  gapLine,
  hosts,
  isMcpAuto,
  isMode,
  lineOf,
  pinName,
  remoteStatus,
  READ_MESSAGES_MAX,
  safeCode,
  spaceReadOf,
  truncate,
  uiAgents,
  uiMcpAuto,
  sendResult,
  uiQuestions,
  validDeviceId,
} from './rules';
import type {
  ConfirmView,
  FleetClient,
  FleetDeviceView,
  FleetSnapshot,
  PushIdentity,
  QuestionView,
  SpaceLine,
  SpaceView,
} from './types';

export { FleetError } from './errors';

export const PROTOCOL_VERSION = 6;
/** Most confirms kept at once (the oldest go first). */
export const CONFIRMS_KEPT = 20;
/** A late answer to a confirm: answered elsewhere, or expired. */
const LATE_CONFIRM = 'fleet.invalid';
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
/** The cloud closed this link: a newer connection of the same device took over. */
export const REPLACED_CLOSE = 4000;

export const REPLACED_TEXT =
  'this device connected from another tab or window; back here, it connects again';

/**
 * The fleet clients of this JS context, each saying which org it is linked
 * to (or dialing) right now. Two of them on one device key take the link
 * from each other forever (close 4000 both ways); this lets the one that
 * was replaced tell "a twin in this same app" from "another tab".
 */
type LiveProbe = () => string | null;
const g = globalThis as { __theodoreFleetLinks?: Set<LiveProbe> };
const liveLinks = (g.__theodoreFleetLinks ??= new Set<LiveProbe>());

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
  /** `read_file` waits this long: the host seals and uploads up to 50 MiB
   *  before it answers. */
  readFileWaitMs?: number;
}

export const DEFAULT_TIMING: FleetTiming = {
  backoffBaseMs: 500,
  backoffMaxMs: 30_000,
  pingEveryMs: 15_000,
  handshakeMs: 45_000,
  replyWaitMs: 15_000,
  startWaitMs: 30_000,
  pendingTtlMs: 150_000,
  readFileWaitMs: 120_000,
};

export interface FleetDeps {
  platform: FleetPlatform;
  /** Pins and the device id per org (defaults to the platform's). */
  storage: SecretStorage;
  /** The spaces kept across restarts (defaults to the platform's). */
  data: DataStorage;
  /** A change is saved this long after it (sooner going to the background). */
  saveDelayMs: number;
  cloudUrl: string;
  fetch: typeof fetch;
  timing: FleetTiming;
  now: () => number;
  /** In [0, 1): backoff jitter. */
  random: () => number;
  /**
   * Where the snapshot is published (defaults to the app's `useFleetState`).
   * A throwaway store for a short-lived client (registering a push token
   * in another account's org) keeps it off the screens.
   */
  store: FleetStore;
  /** Random bytes for blob ids, keys and nonces (defaults to `crypto`). */
  randomBytes: (n: number) => Uint8Array;
  /** The cloud's blob store (defaults to one over `fetch` and `cloudUrl`). */
  blobs?: BlobStore;
}

/** The part of the zustand store the client writes. */
export interface FleetStore {
  setState: typeof useFleetState.setState;
  getState: () => FleetSnapshot;
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
  /** Telemetry: the request id (its op id), the op, when it went out, the
   *  target's kind; never the text. */
  reqId: string;
  op: string;
  at: number;
  targetKind: string;
  done: boolean;
}

interface Tracked {
  view: SpaceView;
  lines: SpaceLine[];
  lastSeq: number;
  startedName: string | null;
  /** The host's own rows, when it mirrors them. */
  mirror: SpaceMirror;
  /** Subscribed (after a verified ok start, or followed). */
  subscribed: boolean;
  /** Followed, read back after a restart: subscribed once a delegation still says so. */
  awaiting: boolean;
  /** Last time something of it arrived: the most recent ones are kept. */
  seenAt: number;
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

/** A fleet client that can also be taken down for good (`dispose`). */
export interface OwnedFleetClient extends FleetClient {
  /** Stops it and drops its listeners: nothing of it runs again. */
  dispose(): void;
}

export function createFleetClient(
  auth: AuthClient,
  keys: KeyStore = createKeyStore(),
  overrides: Partial<FleetDeps> = {},
): OwnedFleetClient {
  const platform = overrides.platform ?? defaultPlatform();
  const deps: FleetDeps = {
    platform,
    storage: overrides.storage ?? platform.storage,
    data: overrides.data ?? platform.data,
    saveDelayMs: overrides.saveDelayMs ?? 1000,
    cloudUrl: overrides.cloudUrl ?? config.cloudUrl,
    fetch: overrides.fetch ?? ((...a) => fetch(...a)),
    timing: overrides.timing ?? DEFAULT_TIMING,
    now: overrides.now ?? Date.now,
    random: overrides.random ?? Math.random,
    store: overrides.store ?? useFleetState,
    randomBytes: overrides.randomBytes ?? randomBytes,
    blobs: overrides.blobs,
  };
  const t = deps.timing;
  const pins: PinStore = pinStore(deps.storage);
  const saved = savedSpaces(deps.data);
  const store = deps.store;
  const set = store.setState;
  const blobs: BlobStore =
    deps.blobs ??
    createBlobStore({
      cloudUrl: deps.cloudUrl,
      fetch: deps.fetch,
      token: () => auth.accessToken(),
    });

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
  /**
   * Another connection of this device took the link (close 4000): no
   * redial until the app is in front again, or start().
   */
  let heldOff = false;
  /** A twin client of this JS context has the link: this one stays quiet. */
  let superseded = false;
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
  const confirms = new Map<
    string,
    { view: ConfirmView; expiry: ReturnType<typeof setTimeout> }
  >();
  /** `<user>.<org>` whose saved set is loaded and written; `null`: none yet. */
  let scope: string | null = null;
  /** The device id the loaded set was written for. */
  let savedFor: string | null = null;
  let dirty = new Set<string>();
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Storage writes, one at a time and in order (a clear after a write). */
  let ops: Promise<void> = Promise.resolve();
  /** Telemetry: when the current dial started, when it was welcomed. */
  let dialedAt = 0;
  let welcomedAt = 0;
  let dialAttempt = 0;

  const kindOf = (deviceId: string): string =>
    String(devices.find((d) => d.device_id === deviceId)?.info?.kind ?? '');

  /** One `fleet_request` per request, whatever settles it first. */
  const settledRequest = (p: Pending, a: Answer, over: 'socket' | 'http') => {
    if (p.done) return;
    p.done = true;
    const ms = Math.max(0, deps.now() - p.at);
    const outcome =
      a.kind === 'ok' ? 'ok' : a.kind === 'timeout' ? 'timeout' : 'refused';
    const code = a.kind === 'err' || a.kind === 'refused' ? a.code : null;
    track('fleet_request', {
      op: p.op,
      target_kind: p.targetKind,
      ms,
      outcome,
      code,
      over,
    });
    const fields = {
      op_id: p.reqId,
      op: p.op,
      target_device: p.target,
      ms,
      outcome,
      code,
    };
    if (outcome === 'ok') log.info('fleet request done', fields);
    else
      log.warn('fleet request failed', {
        ...fields,
        'error.code': code ?? `fleet.${outcome}`,
      });
  };

  // ── publishing ──────────────────────────────────────────────────────────
  const publishSpaces = () =>
    set({
      // Archived ones stay tracked (Undo) but aren't listed.
      spaces: [...tracked.values()]
        .filter((x) => !x.view.archived)
        .map((x) => ({
          ...x.view,
          activeAt: x.mirror.space?.updated_at || x.seenAt,
        })),
    });
  const publishLines = (space: string) => {
    const x = tracked.get(space);
    if (x) set((s) => ({ lines: { ...s.lines, [space]: [...x.lines] } }));
  };
  const publishMirror = (space: string) => {
    const x = tracked.get(space);
    if (x) set((s) => ({ mirrors: { ...s.mirrors, [space]: x.mirror } }));
  };
  const publishQuestions = () =>
    set({ questions: [...questions.values()].map((q) => q.view) });
  const publishConfirms = () =>
    set({ confirms: [...confirms.values()].map((c) => c.view) });
  /** Drops a confirm; `true` if it was here. */
  const dropConfirm = (id: string): boolean => {
    const c = confirms.get(id);
    if (!c) return false;
    clearTimeout(c.expiry);
    confirms.delete(id);
    publishConfirms();
    return true;
  };
  const clearConfirms = () => {
    for (const c of confirms.values()) clearTimeout(c.expiry);
    confirms.clear();
  };
  const publishDevices = async () => {
    const pinned = new Map((await pins.list()).map((p) => [p.deviceId, p]));
    const nameOf = (d: DeviceSummary): string => {
      const pin = pinned.get(d.device_id);
      return pin && pin.publicKey === d.public_key
        ? pin.name
        : truncate(String(d.info?.name ?? ''), 100);
    };
    const listedName = (id: string): string | null => {
      const d = devices.find((x) => x.device_id === id);
      return d ? nameOf(d) : null;
    };
    const views: FleetDeviceView[] = devices.map((d) => {
      const pin = pinned.get(d.device_id);
      const trusted = !!pin && pin.publicKey === d.public_key;
      return {
        deviceId: d.device_id,
        name: nameOf(d),
        kind: String(d.info?.kind ?? ''),
        os: String(d.info?.os ?? ''),
        online: d.online === true,
        acceptsRemote: d.info?.accepts_remote === true,
        maxMode: isMode(d.info?.max_mode) ? d.info.max_mode : 'ask',
        projects: Array.isArray(d.info?.projects)
          ? d.info.projects.map((p) => ({ id: p.id, name: p.name }))
          : [],
        // Only from a host that takes remote spaces (docs/fleet.md).
        agents: d.info?.accepts_remote === true ? uiAgents(d.info.agents) : [],
        publicKey: d.public_key,
        fingerprint: fingerprint(d.public_key),
        trusted,
        thisDevice: d.device_id === me,
        // Only a computer pins `mcp` devices (docs/fleet.md "Auto mode").
        mcpAuto: hosts(String(d.info?.kind ?? ''))
          ? uiMcpAuto(d.info?.mcp_auto, deps.now(), listedName)
          : [],
      };
    });
    set({ devices: views });
  };
  const setConnection = (
    connection: 'off' | 'connecting' | 'connected' | 'error',
    error: string | null = null,
  ) => {
    if (!superseded) set({ connection, error, deviceId: me });
  };
  const liveProbe: LiveProbe = () =>
    wanted && !superseded && (link || dialing)
      ? (link?.org ?? session?.organizationId ?? null)
      : null;
  liveLinks.add(liveProbe);

  /** Sign-out or org switch: nothing of the old fleet stays on screen. */
  const forgetFleet = () => {
    for (const p of pending.values()) {
      clearTimeout(p.expiry);
      p.settle({ kind: 'timeout' });
    }
    pending.clear();
    tracked.clear();
    questions.clear();
    clearConfirms();
    devices = [];
    rawDelegations = [];
    delegators = new Map();
    me = null;
    set({ ...initialFleet, fingerprint: store.getState().fingerprint });
  };

  // ── kept across restarts ────────────────────────────────────────────────
  const queue = (op: () => Promise<void>): Promise<void> =>
    (ops = ops.then(op).catch(() => {}));

  const toSaved = (x: Tracked): SavedSpace => ({
    view: { ...x.view },
    lastSeq: x.lastSeq,
    startedName: x.startedName,
    seenAt: x.seenAt,
    lines: x.lines.slice(-SAVED_LINES),
    mirror: {
      space: x.mirror.space,
      messages: Object.values(x.mirror.messages),
      subSpaces: Object.values(x.mirror.subSpaces),
    },
  });

  /** Writes what changed now; resolves once it is stored. */
  const flush = (): Promise<void> => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    const s = scope;
    const device = me ?? savedFor;
    if (!s || !device) return ops;
    const changed = dirty;
    dirty = new Set();
    const list = [...tracked.values()]
      .filter((x) => x.subscribed || x.awaiting)
      .map(toSaved);
    return queue(() => saved.write(s, device, list, changed));
  };

  const scheduleSave = () => {
    saveTimer ??= setTimeout(() => void flush(), deps.saveDelayMs);
  };

  /** Something of `x` changed: saved soon, and it counts as recent. */
  const touch = (x: Tracked) => {
    x.seenAt = deps.now();
    dirty.add(x.view.space);
    scheduleSave();
  };

  /**
   * Leaves the listed account / org. Sign-out (`forget`) removes its saved
   * set; an org switch keeps it (sets are per org), so switching back lists
   * that org's spaces again.
   */
  const leaveScope = (forget: boolean) => {
    const old = scope;
    scope = null;
    savedFor = null;
    dirty = new Set();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    if (old && forget) void queue(() => saved.clear(old));
  };

  /** Spaces gone from the list: their lines and mirror leave the store too. */
  const dropShown = (gone: string[]) => {
    if (!gone.length) return;
    publishSpaces();
    set((s) => {
      const lines = { ...s.lines };
      const mirrors = { ...s.mirrors };
      for (const id of gone) {
        delete lines[id];
        delete mirrors[id];
      }
      return { lines, mirrors };
    });
    scheduleSave();
  };

  /**
   * The saved set of `next`, listed before the socket opens. One written
   * for another device id (a backup restored on another phone, this one
   * removed and joined again) is dropped.
   */
  const restore = async (next: string, device: string | null) => {
    if (scope === next) return;
    if (scope !== null) {
      // Another account or org than the one listed: none of it stays shown
      // (its saved set stays for when it's back).
      leaveScope(false);
      forgetFleet();
    }
    const restoreStart = deps.now();
    const list = await saved.load(next, device);
    track('saved_spaces_restored', {
      count: list.length,
      ms: Math.max(0, deps.now() - restoreStart),
    });
    scope = next;
    savedFor = device;
    const lines: Record<string, SpaceLine[]> = {};
    const mirrors: Record<string, SpaceMirror> = {};
    for (const r of list) {
      if (tracked.has(r.view.space)) continue;
      const followed = !r.view.startedHere;
      const x: Tracked = {
        view: r.view,
        lines: r.lines,
        lastSeq: r.lastSeq,
        startedName: r.startedName,
        mirror: {
          space: r.mirror.space,
          messages: Object.fromEntries(r.mirror.messages.map((m) => [m.id, m])),
          steps: {},
          subSpaces: Object.fromEntries(
            (r.mirror.subSpaces ?? []).map((c) => [c.space, c]),
          ),
        },
        subscribed: !followed,
        awaiting: followed,
        seenAt: r.seenAt,
      };
      tracked.set(r.view.space, x);
      lines[r.view.space] = [...x.lines];
      mirrors[r.view.space] = x.mirror;
    }
    if (!list.length) return;
    publishSpaces();
    set((s) => ({
      lines: { ...s.lines, ...lines },
      mirrors: { ...s.mirrors, ...mirrors },
    }));
  };

  /** A live delegation of `origin` to this device. */
  const delegatedBy = (origin: string) => {
    const exp = delegators.get(origin);
    return exp !== undefined && (exp === 0 || exp > deps.now());
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

  const disconnected = (
    reason:
      'lost' | 'replaced' | 'fatal' | 'background' | 'stopped' | 'account',
    code: string | number | null = null,
  ) => {
    if (!welcomedAt) return;
    const connectedMs = Math.max(0, deps.now() - welcomedAt);
    welcomedAt = 0;
    const fields = {
      reason,
      code: code === null ? null : String(code),
      connected_ms: connectedMs,
    };
    track('fleet_disconnected', fields);
    log.info('fleet disconnected', fields);
  };

  const lost = (l: Link, code: number | null = null) => {
    if (link !== l) return;
    closeLink();
    disconnected('lost', code);
    setConnection('connecting');
    scheduleRedial();
  };

  const toFatal = async (l: Link, code: string) => {
    if (link !== l) return;
    closeLink();
    disconnected('fatal', code);
    log.warn('the cloud refused this device', { 'error.code': code });
    fatal = { token: l.token };
    if (code === 'fleet.removed') {
      // Gone from the cloud: the next link joins as a new device.
      await deps.storage.remove(deviceIdKey(l.org)).catch(() => {});
    }
    setConnection('error', fatalText(code));
  };

  /** Close 4000: another connection of this device has the link now. */
  const replaced = (l: Link) => {
    if (link !== l) return;
    closeLink();
    disconnected('replaced', REPLACED_CLOSE);
    const probe = liveProbe;
    const twin = [...liveLinks].some((p) => p !== probe && p() === l.org);
    if (twin) {
      // A second client in this same app (a dev reload kept the old one):
      // never dial again and never write the shared store again.
      superseded = true;
      wanted = false;
      liveLinks.delete(probe);
      return;
    }
    heldOff = true;
    setConnection('error', REPLACED_TEXT);
  };

  const scheduleRedial = () => {
    if (
      !wanted ||
      fatal ||
      heldOff ||
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
    if (!wanted || fatal || heldOff || link || dialing) return;
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
      if (mine !== epoch) return;
      await restore(
        savedScope(s.userId, s.organizationId),
        validDeviceId(stored) ? stored : null,
      );
      if (mine !== epoch || !wanted || fatal || heldOff || link) return;
      if (background && platform.closeInBackground) return;
      setConnection('connecting');
      dialedAt = deps.now();
      dialAttempt = attempt;
      log.debug('fleet dialing', { attempt });
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
        if (code === REPLACED_CLOSE) {
          replaced(l);
        } else if (FATAL_CLOSE.includes(code)) {
          const reason = ev?.reason ?? '';
          void toFatal(
            l,
            (FATAL_CODES as readonly string[]).includes(reason)
              ? reason
              : 'fleet.unauthorized',
          );
        } else {
          lost(l, code);
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
      log.warn('the fleet failed to start', {
        'error.code': 'fleet.start_failed',
        error: e instanceof Error ? e.message : String(e),
      });
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
      welcomedAt = deps.now();
      {
        const welcomeMs = Math.max(0, welcomedAt - dialedAt);
        track('fleet_connected', {
          welcome_ms: welcomeMs,
          attempts: dialAttempt + 1,
          protocol: PROTOCOL_VERSION,
          resumed: tracked.size > 0,
        });
        log.info('fleet connected', {
          welcome_ms: welcomeMs,
          attempts: dialAttempt + 1,
          protocol: PROTOCOL_VERSION,
          device_id: me,
          spaces: tracked.size,
        });
      }
      if (savedFor !== me) {
        // What was kept belongs to another device id: the cloud won't
        // let this one follow it.
        const gone = savedFor ? [...tracked.keys()] : [];
        for (const id of gone) tracked.delete(id);
        savedFor = me;
        dropShown(gone);
      }
      await deps.storage.set(deviceIdKey(l.org), msg.device_id).catch(() => {});
      if (link !== l) return;
      setConnection('connected');
      // Waiting confirms come again after every welcome: one answered or
      // gone meanwhile must not stay.
      if (confirms.size) {
        clearConfirms();
        publishConfirms();
      }
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
        await publishDevices();
        // The first list of this run: Home and the drawer leave their
        // loading state (src/ui/load.ts).
        if (!superseded) set({ welcomed: true });
        return;
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
        await verifyDelegations();
        return resumeFollowed();
      case 'confirm':
        return onConfirm(msg.envelope);
      case 'confirm_dismissed':
        dropConfirm(String(msg.confirm_id));
        return;
      default:
        // `request` / `claim_result`, or a type this build doesn't know:
        // never a target, nothing to run.
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
    settledRequest(p, a, 'socket');
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
        touch(x);
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
      mirror: emptyMirror(),
      subscribed: true,
      awaiting: false,
      seenAt: deps.now(),
    };
    tracked.set(space, x);
    sendMsg({ type: 'subscribe', space, since: 0 });
    publishSpaces();
    touch(x);
    return x;
  };

  /**
   * Followed spaces read back after a restart: subscribed again from the
   * last seq while their origin (not known: any origin) still delegates
   * here; else forgotten.
   */
  const resumeFollowed = () => {
    const gone: string[] = [];
    for (const [space, x] of [...tracked]) {
      if (!x.awaiting) continue;
      const origin = x.view.originDevice;
      if (origin ? delegatedBy(origin) : delegated()) {
        x.awaiting = false;
        x.subscribed = true;
        sendMsg({ type: 'subscribe', space, since: x.lastSeq });
      } else {
        tracked.delete(space);
        gone.push(space);
      }
    }
    dropShown(gone);
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

  /** The host's own row: kept, and the space row speaks for the list. */
  const applyMirrorEvent = (x: Tracked, seq: number, ev: RemoteSpaceEvent) => {
    if (ev.kind !== 'mirror') return;
    // Compaction leaves holes in seq: they aren't gaps.
    x.lastSeq = seq;
    touch(x);
    const before = x.mirror;
    const next = applyMirror(before, x.view.space, ev.model, ev.id, ev.data);
    if (next === before) return;
    x.mirror = next;
    const v = x.view;
    const row = next.space;
    if (row) {
      const title = mirrorTitle(row);
      if (title) v.name = title;
      if (row.branch) v.branch = row.branch;
      if (isMode(row.mode)) v.mode = row.mode;
      v.status = mirrorStatus(row);
      // The host's word on archiving, from here or from the computer.
      if (row.status === 'archived') v.archived = true;
      else delete v.archived;
      const q = row.question;
      if (q) {
        v.question = {
          askId: q.id,
          space: v.space,
          from: `${v.hostName} · ${x.startedName || title}`,
          questions: uiQuestions(q.questions),
        };
      } else if (
        v.question &&
        v.question.askId === before.space?.question?.id
      ) {
        v.question = null;
      }
    }
    const reply = latestReply(next);
    if (reply !== null) v.lastReply = truncate(reply, 8000);
    publishSpaces();
    publishMirror(v.space);
  };

  const applyEvent = (x: Tracked, seq: number, ev: RemoteSpaceEvent) => {
    if (seq <= x.lastSeq || !isObj(ev)) return;
    if (ev.kind === 'mirror') return applyMirrorEvent(x, seq, ev);
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
    touch(x);
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
    touch(x);
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

  /** A host's confirm: only with its pin, signed by it as `host_device`. */
  const onConfirm = async (envelope: SignedEnvelope) => {
    if (!isObj(envelope) || typeof envelope.device_id !== 'string') return;
    const pin = await pins.get(envelope.device_id);
    if (!pin) return;
    const body = open(envelope, pin.publicKey, 'confirm');
    if (!body || body.host_device !== envelope.device_id) return;
    const now = deps.now();
    const view = confirmOf(body, pin.name, now);
    if (!view) return;
    const before = confirms.get(view.confirmId);
    if (before) clearTimeout(before.expiry);
    confirms.delete(view.confirmId);
    while (confirms.size >= CONFIRMS_KEPT) {
      const oldest = confirms.keys().next().value;
      if (oldest === undefined) break;
      clearTimeout(confirms.get(oldest)!.expiry);
      confirms.delete(oldest);
    }
    confirms.set(view.confirmId, {
      view,
      // Refused on the host from then on: nothing left to answer.
      expiry: setTimeout(
        () => dropConfirm(view.confirmId),
        Math.min(view.expiresAtMs - now, 2 ** 31 - 1),
      ),
    });
    publishConfirms();
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
  ): Promise<{ answer: Promise<Answer>; reqId: string }> => {
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
    const p: Pending = {
      space: 'space' in op ? op.space : '',
      start,
      target,
      targetKey: pin.publicKey,
      settle,
      expiry: setTimeout(() => {
        pending.delete(reqId);
        settledRequest(p, { kind: 'timeout' }, 'socket');
      }, t.pendingTtlMs),
      reqId,
      op: op.op,
      at: deps.now(),
      targetKind: kindOf(target),
      done: false,
    };
    pending.set(reqId, p);
    log.debug('fleet request sent', {
      op_id: reqId,
      op: op.op,
      target_device: target,
    });
    if (!sendMsg({ type: 'request', envelope })) {
      clearTimeout(p.expiry);
      pending.delete(reqId);
      p.done = true;
      log.warn('fleet request not sent', {
        op_id: reqId,
        op: op.op,
        'error.code': 'fleet.not_connected',
      });
      throw new FleetError(
        'not connected to the fleet, or the request is too large',
      );
    }
    return { answer, reqId };
  };

  /** `answer` within `ms`, else a timeout (the request stays pending for
   *  its TTL: a late reply still lands, and counts once). */
  const within = (
    answer: Promise<Answer>,
    ms: number,
    reqId?: string,
  ): Promise<Answer> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        const p = reqId ? pending.get(reqId) : undefined;
        if (p) settledRequest(p, { kind: 'timeout' }, 'socket');
        resolve({ kind: 'timeout' });
      }, ms);
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

  /** A request to `host`: its verified ok value within the wait, or throws. */
  const steerOn = async (host: string, op: RemoteOp): Promise<unknown> => {
    const { answer, reqId } = await request(host, op, false);
    const a = await within(answer, t.replyWaitMs, reqId);
    const err = answerError(a);
    if (err) throw err;
    return a.kind === 'ok' ? a.value : null;
  };

  /** A send, stop or answer of a space followed here: the host's verified
   *  ok value within the wait, or throws. */
  const steer = (space: string, op: RemoteOp): Promise<unknown> =>
    steerOn(hostOf(space), op);

  /** A space's local id on a host (12 hex, or an `rs_` id), nothing else
   *  goes on the wire. */
  const localSpaceId = (space: string): string => {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(space))
      throw new FleetError('not a space id');
    return space;
  };

  /**
   * The attachments of a request as the host checks them (docs/fleet.md
   * "Files (blobs)"): at most 10, each valid, each ≤ 20 MiB, no id twice.
   */
  const checkedAttachments = (list: readonly BlobRef[] = []): BlobRef[] => {
    if (list.length > MAX_ATTACHMENTS)
      throw new FleetError(`at most ${MAX_ATTACHMENTS} files per message`);
    const ids = new Set<string>();
    for (const r of list) {
      const bad = validateBlobRef(r);
      if (bad) throw new FleetError(`attachment ${r?.name ?? ''}: bad ${bad}`);
      if (r.size > MAX_ATTACHMENT_BYTES)
        throw new FleetError(`${r.name} is over 20 MiB`);
      if (ids.has(r.blob_id))
        throw new FleetError(`${r.name} is attached twice`);
      ids.add(r.blob_id);
    }
    return [...list];
  };

  /** The pin of `hostDevice`, only while the cloud lists that same key. */
  const pinnedHost = async (hostDevice: string): Promise<Pin> => {
    const pin = await pins.get(hostDevice);
    if (!pin) {
      throw new FleetError(
        `device ${hostDevice} isn't trusted on this device: trust it in Devices first`,
      );
    }
    const listed = devices.find((d) => d.device_id === hostDevice);
    if (listed && listed.public_key !== pin.publicKey) {
      throw new FleetError(
        `${pin.name}'s key changed since it was trusted: compare its fingerprint and trust it again`,
      );
    }
    return pin;
  };

  /**
   * Signs `op` for a pinned `hostDevice` and posts it (`POST
   * /v1/fleet/request`): a notification action, maybe the first thing to
   * run after a cold start, so it loads the session and device id itself.
   * `as`: another signed-in account's token and org (a push for an
   * account that isn't the active one), with this device's id in that org.
   * Resolves once the cloud accepted it; the host's word comes later.
   */
  const overHttp = async (
    hostDevice: string,
    op: RemoteOp,
    as: PushIdentity | null = null,
  ) => {
    let token: string | null;
    let organizationId: string | null;
    if (as) {
      ({ accessToken: token, organizationId } = as);
    } else {
      const s = await auth.current();
      token = await auth.accessToken();
      if (!s || !token) throw new FleetError('not signed in');
      organizationId = s.organizationId;
    }
    if (!organizationId) throw new FleetError('no organization chosen');
    const origin =
      (!as || link?.org === organizationId ? me : null) ??
      (await deps.storage.get(deviceIdKey(organizationId)));
    if (!validDeviceId(origin)) {
      throw new FleetError(
        'this device has not joined the fleet yet: open the app once',
      );
    }
    const pin = await pins.get(hostDevice);
    if (!pin)
      throw new FleetError(`device ${hostDevice} isn't trusted on this device`);
    const key = await keys.deviceKey();
    const reqId = `req_${platform.randomUUID()}`;
    const at = deps.now();
    const envelope = await seal(
      {
        req_id: reqId,
        origin_device: origin,
        target_device: hostDevice,
        target_key: pin.publicKey,
        issued_at_ms: at,
        op,
      },
      key,
    );
    log.debug('fleet request posted', {
      op_id: reqId,
      op: op.op,
      target_device: hostDevice,
    });
    const httpDone = (outcome: 'ok' | 'refused', code: string | null) => {
      track('fleet_request', {
        op: op.op,
        target_kind: kindOf(hostDevice),
        ms: Math.max(0, deps.now() - at),
        outcome,
        code,
        over: 'http',
      });
      if (outcome !== 'ok')
        log.warn('fleet request over HTTP refused', {
          op_id: reqId,
          op: op.op,
          'error.code': code ?? 'fleet.refused',
        });
    };
    let res: Response;
    try {
      res = await deps.fetch(
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
    } catch (e) {
      httpDone('refused', 'fleet.network');
      throw e;
    }
    const json: unknown = await res.json().catch(() => null);
    const body = isObj(json) ? json : {};
    const refusal = isObj(body.refused)
      ? body.refused
      : isObj(body.error)
        ? body.error
        : null;
    if (!res.ok || refusal || body.accepted === false) {
      const code = safeCode(refusal?.code ?? body.code);
      httpDone('refused', code);
      throw new FleetError(`refused by the cloud: ${code}`, code);
    }
    httpDone('ok', null);
  };

  const client: FleetClient = {
    async start() {
      if (superseded) return;
      wanted = true;
      fatal = null;
      heldOff = false;
      attempt = 0;
      await connect();
    },

    stop() {
      wanted = false;
      heldOff = false;
      closeLink();
      disconnected('stopped');
      if (superseded) return;
      setConnection('off');
      void flush();
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
        mirror: emptyMirror(),
        subscribed: false,
        awaiting: false,
        seenAt: deps.now(),
      };
      tracked.set(space, x);
      publishSpaces();
      let answer: Promise<Answer>;
      let reqId: string;
      try {
        ({ answer, reqId } = await request(
          target.device_id,
          {
            op: 'start_space',
            space,
            project_id: req.projectId,
            goal,
            mode: req.mode,
            // Only what was picked: the host's defaults run for the rest.
            agent: req.agent ?? null,
            model: req.model ?? null,
            effort: req.effort ?? null,
            depth: 0,
            attachments: checkedAttachments(req.attachments),
          },
          true,
        ));
      } catch (e) {
        tracked.delete(space);
        publishSpaces();
        throw e;
      }
      const a = await within(answer, t.startWaitMs, reqId);
      // A start the host is slow to answer stays `starting`; its reply
      // still lands while the request is pending.
      if (a.kind !== 'ok' && a.kind !== 'timeout') throw answerError(a)!;
      return { ...(tracked.get(space)?.view ?? x.view) };
    },

    async send(space, text, mode = null, picks = {}, attachments = []) {
      if (!text.trim()) throw new FleetError('empty message');
      const files = checkedAttachments(attachments);
      const x = tracked.get(space);
      const before = x?.view.status;
      // Running from now: the last turn's idle must not linger.
      if (x) {
        x.view.status = 'running';
        publishSpaces();
      }
      try {
        const value = await steer(space, {
          op: 'send',
          space,
          text,
          mode: isMode(mode) ? mode : null,
          // From this turn on; none keeps the space's.
          agent: picks.agent ?? null,
          model: picks.model ?? null,
          effort: picks.effort ?? null,
          attachments: files,
        });
        return sendResult(value);
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

    async archiveSpace(space) {
      await steer(space, { op: 'archive_space', space });
      const x = tracked.get(space);
      if (!x) return;
      x.view.archived = true;
      touch(x);
      publishSpaces();
    },

    async unarchiveSpace(space) {
      await steer(space, { op: 'unarchive_space', space });
      const x = tracked.get(space);
      if (!x) return;
      delete x.view.archived;
      touch(x);
      publishSpaces();
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
      track('device_trusted', { trusted: true, kind: kindOf(deviceId) });
      log.info('device trusted', { device_id: deviceId });
      await verifyDelegations();
      await publishDevices();
    },

    async untrust(deviceId) {
      await pins.remove(deviceId);
      track('device_trusted', { trusted: false, kind: kindOf(deviceId) });
      log.info('device untrusted', { device_id: deviceId });
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

    async dropPushHere() {
      // The token itself stays: the next link (another account or org)
      // registers it again at its welcome.
      if (push?.token)
        sendMsg({ type: 'register_push', provider: 'expo', token: '' });
    },

    async forgetSaved(scopes) {
      for (const s of scopes) {
        if (s === scope) leaveScope(true);
        else await queue(() => saved.clear(s));
      }
      await ops;
    },

    async answerOverHttp(space, askId, answers, hostDevice, as = null) {
      await overHttp(
        hostDevice,
        { op: 'answer', space, ask_id: askId, answers },
        as,
      );
      if (questions.delete(askId)) publishQuestions();
    },

    async confirm(hostDevice, confirmId, allow) {
      const { answer, reqId } = await request(
        hostDevice,
        { op: 'confirm', confirm_id: confirmId, allow },
        false,
      );
      // Sent: the card goes, whatever the host says.
      dropConfirm(confirmId);
      const a = await within(answer, t.replyWaitMs, reqId);
      // Answered elsewhere first, or too late: nothing to tell.
      if (a.kind === 'err' && a.code === LATE_CONFIRM) return;
      const err = answerError(a);
      if (err) throw err;
    },

    async confirmOverHttp(hostDevice, confirmId, allow, as = null) {
      await overHttp(
        hostDevice,
        { op: 'confirm', confirm_id: confirmId, allow },
        as,
      );
      dropConfirm(confirmId);
    },

    async setMcpAuto(hostDevice, mcpDevice, auto, untilMs) {
      if (!validDeviceId(mcpDevice) || !isMcpAuto(auto))
        throw new FleetError('not an auto mode this app can set');
      const until =
        auto === 'off' || untilMs === null || !Number.isFinite(untilMs)
          ? null
          : Math.floor(untilMs);
      const { answer, reqId } = await request(
        hostDevice,
        { op: 'set_mcp_auto', mcp_device: mcpDevice, auto, until_ms: until },
        false,
      );
      const err = answerError(await within(answer, t.replyWaitMs, reqId));
      if (err) throw err;
    },

    async readSpace(hostDevice, space, messages = READ_MESSAGES_MAX) {
      const id = localSpaceId(space);
      const value = await steerOn(hostDevice, {
        op: 'read_space',
        space: id,
        messages: Math.max(
          1,
          Math.min(READ_MESSAGES_MAX, Math.floor(messages)),
        ),
      });
      const read = spaceReadOf(value, id);
      if (!read)
        throw new FleetError("the host's answer wasn't about that space");
      return read;
    },

    async sendTo(hostDevice, space, text, attachments = []) {
      const message = text.trim();
      if (!message) throw new FleetError('empty message');
      const value = await steerOn(hostDevice, {
        op: 'send_to',
        space: localSpaceId(space),
        message,
        attachments: checkedAttachments(attachments),
      });
      return sendResult(value);
    },

    async uploadAttachment(hostDevice, file, onProgress) {
      if (file.bytes.length > MAX_ATTACHMENT_BYTES)
        throw new FleetError(`${file.name} is over 20 MiB`);
      // Sealed for the key pinned here: the host opens it with its seed.
      const pin = await pinnedHost(hostDevice);
      const { ref, chunks } = sealBlob(
        pin.publicKey,
        file.bytes,
        file.name,
        file.mime,
        {
          blobId: [...deps.randomBytes(16)]
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(''),
          ephSk: deps.randomBytes(32),
          noncePrefix: deps.randomBytes(16),
        },
      );
      await blobs.upload(ref, chunks, (done, total) =>
        onProgress?.(total ? done / total : 1),
      );
      return ref;
    },

    async deleteBlob(blobId) {
      if (!/^[0-9a-f]{32}$/.test(blobId)) throw new FleetError('not a blob id');
      await blobs.remove(blobId);
    },

    async readFile(hostDevice, space, path, maxBytes = MAX_READ_FILE_BYTES) {
      const id = localSpaceId(space);
      if (
        path === '' ||
        [...path].length > MAX_PATH_CHARS ||
        path.includes('\0')
      )
        throw new FleetError('not a file path');
      const cap = Math.max(
        1,
        Math.min(MAX_READ_FILE_BYTES, Math.floor(maxBytes)),
      );
      const { answer } = await request(
        hostDevice,
        { op: 'read_file', space: id, path, max_bytes: cap },
        false,
      );
      const a = await within(answer, t.readFileWaitMs ?? t.replyWaitMs);
      const err = answerError(a);
      if (err) throw err;
      const v = a.kind === 'ok' && isObj(a.value) ? a.value : null;
      const ref = v?.blob;
      if (!isBlobRef(ref))
        throw new FleetError("the host's answer wasn't a file");
      if (ref.size > cap)
        throw new FleetError(
          'the file is larger than asked for',
          'fleet.too_large',
        );
      return ref;
    },

    async canOpenBlobs() {
      const key = await keys.deviceKey();
      return !!key.blobOpener;
    },

    async fetchBlob(ref, onProgress) {
      const bad = validateBlobRef(ref);
      if (bad) throw new FleetError(`not a file reference: bad ${bad}`);
      const key = await keys.deviceKey();
      if (!key.blobOpener)
        throw new FleetError(
          "this device's key can't open files: use the app on a phone",
        );
      try {
        const chunks = await blobs.download(ref, (done, total) =>
          onProgress?.(total ? done / total : 1),
        );
        return openBlob(key.blobOpener, ref, chunks);
      } finally {
        // Read once: the cloud copy goes, opened or not (a retry asks the
        // host for a fresh one).
        await blobs.remove(ref.blob_id).catch(() => {});
      }
    },

    async answerSpace(hostDevice, space, ask, answers) {
      await steerOn(hostDevice, {
        op: 'answer_space',
        space: localSpaceId(space),
        ask,
        answers,
      });
    },
  };

  // ── account and app lifecycle ───────────────────────────────────────────
  const offAuth = auth.onChange((s) => {
    if (superseded) return;
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
      disconnected('account');
      leaveScope(true);
      forgetFleet();
      return;
    }
    if (!wanted) return;
    if (
      before &&
      (before.userId !== s.userId || before.organizationId !== s.organizationId)
    ) {
      // Another org, or another account (docs/mobile.md "Several
      // accounts"): the link is redialed as it; what was listed goes, its
      // saved set stays for when it is back. Requests in flight are
      // settled as timed out.
      epoch++;
      closeLink();
      disconnected('account');
      leaveScope(false);
      forgetFleet();
      fatal = null;
      heldOff = false;
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

  const offActive = platform.onActive((active) => {
    if (superseded) return;
    background = !active;
    if (!active) {
      // iOS may kill the app from here on: what changed is saved now.
      void flush();
      if (platform.closeInBackground && link) {
        closeLink();
        disconnected('background');
        setConnection('off');
      }
      return;
    }
    // Back in front: this app (or tab) takes the link again.
    heldOff = false;
    if (!wanted || fatal || link) return;
    if (redial) clearTimeout(redial);
    redial = null;
    attempt = 0;
    void connect();
  });

  return {
    ...client,
    dispose() {
      client.stop();
      superseded = true;
      liveLinks.delete(liveProbe);
      offAuth();
      offActive();
    },
  };
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
