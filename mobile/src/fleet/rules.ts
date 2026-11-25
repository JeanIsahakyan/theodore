/**
 * What may be shown, and how, mirroring the desktop core
 * (`crates/app/src/usecases/fleet.rs`, `fleet_origin.rs`).
 */
import type {
  ConfirmAction,
  FleetMode,
  McpAuto,
  RemoteQuestion,
  RemoteSpaceEvent,
} from '../gen/fleet';
import type {
  ConfirmView,
  FleetAgentView,
  McpAutoView,
  FleetModelView,
  LineKind,
  SendResult,
  SpaceLine,
  SpaceStatus,
  SubSpaceRead,
} from './types';

/** `^dev_[0-9a-f-]{36}$`: a device id as the cloud issues it. */
export function validDeviceId(id: unknown): id is string {
  return typeof id === 'string' && /^dev_[0-9a-f-]{36}$/.test(id);
}

const PIN_NAME_MAX = 40;

/**
 * A device name as pinned here: only `[A-Za-z0-9 ._()-]`, ≤ 40 characters,
 * `device` when nothing is left (the cloud's listing is unsigned).
 */
export function pinName(name: string): string {
  const kept = [...name]
    .filter((c) => /^[A-Za-z0-9 ._()-]$/.test(c))
    .slice(0, PIN_NAME_MAX)
    .join('')
    .trim();
  return kept || 'device';
}

/** A refusal code as it may be shown: `fleet.offline`-like, else `fleet.unknown`. */
export function safeCode(code: unknown): string {
  return typeof code === 'string' && /^[a-z0-9_.]{1,64}$/.test(code)
    ? code
    : 'fleet.unknown';
}

/** At most `max` characters (code points) of `s`. */
export function truncate(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : chars.slice(0, max).join('');
}

/** Most characters of a verified refusal's words shown. */
export const ERROR_TEXT_MAX = 200;
/** Most characters of a space name or branch taken from a signed reply. */
export const NAME_MAX = 200;
/** History kept per space. */
export const LINES_KEPT = 500;

export const MODES: readonly FleetMode[] = ['ask', 'plan', 'edit', 'run'];
const STATUSES = ['running', 'idle', 'waiting', 'stopped', 'failed'] as const;

export function isMode(m: unknown): m is FleetMode {
  return (MODES as readonly unknown[]).includes(m);
}

export function remoteStatus(s: unknown): SpaceStatus | null {
  return (STATUSES as readonly unknown[]).includes(s)
    ? (s as SpaceStatus)
    : null;
}

/** `DeviceInfo::fit_agents`' caps (docs/fleet.md "Agent, model and effort"). */
const AGENTS_MAX = 4;
const MODELS_MAX = 12;
const LEVELS_MAX = 8;
const AGENT_ID_MAX = 32;
const MODEL_ID_MAX = 64;
const LEVEL_MAX = 16;
const LABEL_MAX = 64;

/** An id as a request may name it: a non-empty string within `max`, else
 *  `null` (it can't be cut: a cut id names another, or nothing). */
function pickId(v: unknown, max: number): string | null {
  return typeof v === 'string' && v !== '' && [...v].length <= max ? v : null;
}

function modelView(m: unknown): FleetModelView | null {
  if (typeof m !== 'object' || m === null) return null;
  const x = m as Record<string, unknown>;
  const id = pickId(x.id, MODEL_ID_MAX);
  if (!id) return null;
  const efforts = Array.isArray(x.efforts)
    ? [
        ...new Set(
          x.efforts
            .map((e) => pickId(e, LEVEL_MAX))
            .filter((e): e is string => e !== null),
        ),
      ].slice(0, LEVELS_MAX)
    : [];
  const own = pickId(x.default_effort, LEVEL_MAX);
  return {
    id,
    label: truncate(
      typeof x.label === 'string' && x.label ? x.label : id,
      LABEL_MAX,
    ),
    efforts,
    defaultEffort: own && efforts.includes(own) ? own : null,
  };
}

/**
 * A device's `agents` as the UI offers them, shape-checked and within the
 * protocol's caps (the cloud's listing is unsigned; the host checks every
 * pick again). Duplicates are dropped; an older host's absent list is `[]`.
 */
export function uiAgents(v: unknown): FleetAgentView[] {
  if (!Array.isArray(v)) return [];
  const out: FleetAgentView[] = [];
  for (const a of v) {
    if (out.length >= AGENTS_MAX) break;
    if (typeof a !== 'object' || a === null) continue;
    const x = a as Record<string, unknown>;
    const id = pickId(x.id, AGENT_ID_MAX);
    if (!id || out.some((o) => o.id === id)) continue;
    const models: FleetModelView[] = [];
    for (const m of Array.isArray(x.models) ? x.models : []) {
      if (models.length >= MODELS_MAX) break;
      const mv = modelView(m);
      if (mv && !models.some((o) => o.id === mv.id)) models.push(mv);
    }
    out.push({
      id,
      label: truncate(
        typeof x.label === 'string' && x.label ? x.label : id,
        LABEL_MAX,
      ),
      defaultModel: pickId(x.default_model, MODEL_ID_MAX),
      defaultEffort: pickId(x.default_effort, LEVEL_MAX),
      models,
    });
  }
  return out;
}

const AUTOS: readonly McpAuto[] = ['off', 'edit', 'full'];
export const isMcpAuto = (v: unknown): v is McpAuto =>
  (AUTOS as readonly unknown[]).includes(v);

/** Most `mcp_auto` entries taken from one host's (unsigned) listing. */
const MCP_AUTO_MAX = 8;
export const MCP_NAME = 'Claude via cloud';

/**
 * A host's `mcp_auto` as the device screen shows it, shape-checked (the
 * listing is unsigned; the host decides). An entry whose `until_ms` has
 * passed reads `off`. `nameOf`: the `mcp` device's listed name, if any.
 */
export function uiMcpAuto(
  v: unknown,
  now: number,
  nameOf: (deviceId: string) => string | null,
): McpAutoView[] {
  if (!Array.isArray(v)) return [];
  const out: McpAutoView[] = [];
  for (const e of v) {
    if (out.length >= MCP_AUTO_MAX) break;
    if (typeof e !== 'object' || e === null) continue;
    const x = e as Record<string, unknown>;
    if (!validDeviceId(x.device_id) || !isMcpAuto(x.auto)) continue;
    if (out.some((o) => o.deviceId === x.device_id)) continue;
    const until =
      typeof x.until_ms === 'number' && Number.isFinite(x.until_ms)
        ? x.until_ms
        : null;
    const over = until !== null && until <= now;
    out.push({
      deviceId: x.device_id,
      name: nameOf(x.device_id) || MCP_NAME,
      auto: over ? 'off' : x.auto,
      untilMs: over || x.auto === 'off' ? null : until,
    });
  }
  return out;
}

const CONFIRM_ACTIONS: readonly ConfirmAction[] = [
  'start',
  'send',
  'approve_plan',
  'merge',
];
/** `CONFIRM_TEXT_MAX` in Rust. */
export const CONFIRM_TEXT_MAX = 500;
const CONFIRM_ID_MAX = 200;

/**
 * A verified `RemoteConfirm` body as the card shows it, shape-checked;
 * `null` if it isn't one or it has expired by `now`.
 */
export function confirmOf(
  body: unknown,
  hostName: string,
  now: number,
): ConfirmView | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const id = b.confirm_id;
  if (typeof id !== 'string' || !id || id.length > CONFIRM_ID_MAX) return null;
  if (!validDeviceId(b.host_device) || !validDeviceId(b.mcp_device))
    return null;
  if (!(CONFIRM_ACTIONS as readonly unknown[]).includes(b.action)) return null;
  if (!isMode(b.mode)) return null;
  const exp = b.expires_at_ms;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= now)
    return null;
  return {
    confirmId: id,
    hostDevice: b.host_device,
    hostName,
    mcpDevice: b.mcp_device,
    action: b.action as ConfirmAction,
    mode: b.mode,
    projectName: str(b.project_name, NAME_MAX),
    spaceName: str(b.space_name, NAME_MAX),
    text: str(b.text, CONFIRM_TEXT_MAX),
    expiresAtMs: exp,
  };
}

/** Only desktops and daemons host spaces; phones and browsers never do. */
export function hosts(kind: string): boolean {
  return kind === 'desktop' || kind === 'daemon';
}

function statusWord(s: SpaceStatus): string {
  return s === 'waiting' ? 'waiting for an answer' : s;
}

const str = (v: unknown, max: number) =>
  typeof v === 'string' ? truncate(v, max) : '';
const num = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;

/** Questions as the UI takes them, shape-checked. */
export function uiQuestions(
  qs: unknown,
): { question: string; options: string[]; multi: boolean }[] {
  if (!Array.isArray(qs)) return [];
  return qs.slice(0, 20).map((q: Partial<RemoteQuestion>) => ({
    question: str(q?.question, 2000),
    options: Array.isArray(q?.options)
      ? q.options
          .filter((o): o is string => typeof o === 'string')
          .slice(0, 20)
          .map((o) => truncate(o, 500))
      : [],
    multi: q?.multi === true,
  }));
}

/** One verified event as a line of history; `null` if it isn't one. */
export function lineOf(seq: number, ev: RemoteSpaceEvent): SpaceLine | null {
  const e = ev as Record<string, unknown>;
  let kind: LineKind;
  let text: string;
  switch (ev?.kind) {
    case 'started':
      kind = 'started';
      text = `Started ${str(e.name, NAME_MAX)} on ${str(e.branch, NAME_MAX)} (${isMode(e.mode) ? e.mode : 'ask'})`;
      break;
    case 'status': {
      const s = remoteStatus(e.status);
      if (!s) return null;
      kind = 'status';
      text = statusWord(s);
      break;
    }
    case 'turn_started':
      kind = 'turn';
      text = `Turn ${num(e.turn)}: ${str(e.text, 2000)}`;
      break;
    case 'tool': {
      kind = 'tool';
      const name = str(e.name, 100);
      const summary = str(e.summary, 200);
      text = summary ? `${name} ${summary}` : name;
      break;
    }
    case 'reply':
      kind = 'reply';
      text = str(e.text, 8000);
      break;
    case 'turn_ended': {
      kind = 'ended';
      const word = ['done', 'stopped', 'failed'].includes(e.outcome as string)
        ? (e.outcome as string)
        : 'done';
      const m = typeof e.message === 'string' ? str(e.message, 2000) : null;
      text = m
        ? `Turn ${num(e.turn)} ${word}: ${m}`
        : `Turn ${num(e.turn)} ${word}`;
      break;
    }
    case 'question':
      kind = 'question';
      text = uiQuestions(e.questions)
        .map((q) => q.question)
        .join(' / ');
      break;
    case 'question_cleared':
      kind = 'question';
      text = 'Question answered or withdrawn';
      break;
    default:
      return null;
  }
  return { seq, kind, text };
}

/** The cloud's word that events `from..=to` are gone: nothing but a line. */
export function gapLine(from: number, to: number): SpaceLine {
  return {
    seq: from,
    kind: 'gap',
    text: `Events ${from}–${to} are no longer available`,
  };
}

/** Most messages `read_space` is asked for (the host's own cap). */
export const READ_MESSAGES_MAX = 50;
const READ_TEXT_MAX = 8000;
const READ_STATUSES = [
  'setting_up',
  'running',
  'question',
  'waiting',
  'idle',
  'failed',
  'archived',
] as const;
const PROGRESS_STATES = ['pending', 'active', 'done'] as const;

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const optStr = (v: unknown, max: number): string | null =>
  typeof v === 'string' ? truncate(v, max) : null;

/**
 * The host's `ok` value for `read_space` as the sub-space screen takes it,
 * field by field (`crates/ports/src/local_spaces.rs` `LocalSpaceRead`);
 * `null` unless it names `space`. Texts are cut, statuses and modes must be
 * known words, lists are capped.
 */
export function spaceReadOf(
  value: unknown,
  space: string,
): SubSpaceRead | null {
  if (!isObj(value)) return null;
  const s = isObj(value.space) ? value.space : null;
  if (!s || s.space !== space) return null;
  const q = isObj(value.question) ? value.question : null;
  const ask =
    q && typeof q.ask === 'string' && q.ask ? truncate(q.ask, NAME_MAX) : null;
  return {
    space,
    title: str(s.title, NAME_MAX) || str(s.name, NAME_MAX),
    status: (READ_STATUSES as readonly unknown[]).includes(s.status)
      ? (s.status as string)
      : 'unknown',
    mode: isMode(s.mode) ? s.mode : null,
    agent: optStr(s.agent, 40),
    turns:
      Number.isSafeInteger(s.turns) && (s.turns as number) >= 0
        ? (s.turns as number)
        : 0,
    done: s.done === true,
    goal: str(value.goal, READ_TEXT_MAX),
    branch: str(value.branch, NAME_MAX),
    progress: (Array.isArray(value.progress) ? value.progress : [])
      .filter(isObj)
      .slice(0, 50)
      .map((p) => ({
        label: str(p.label, 500),
        state: (PROGRESS_STATES as readonly unknown[]).includes(p.state)
          ? (p.state as (typeof PROGRESS_STATES)[number])
          : 'pending',
      })),
    progressNote: optStr(value.progress_note, 500),
    messages: (Array.isArray(value.messages) ? value.messages : [])
      .filter(isObj)
      .slice(-READ_MESSAGES_MAX)
      .map((m) => ({
        from: str(m.from, 120),
        at: num(m.at),
        text: str(m.text, READ_TEXT_MAX),
        truncated: m.truncated === true,
      })),
    live: optStr(value.live, READ_TEXT_MAX),
    question: ask && q ? { ask, questions: uiQuestions(q.questions) } : null,
    error: optStr(value.error, 2000),
  };
}

/**
 * The host's `ok` value for a send, shape-checked (another device's word):
 * `{message, queued?, position?}` (`fleet_queue.rs` `fleet_send_or_queue`).
 * `message` is the chat row's id the host mirrors later; an older host
 * sends none.
 */
export function sendResult(value: unknown): SendResult {
  const v = (value ?? {}) as {
    message?: unknown;
    queued?: unknown;
    position?: unknown;
  };
  const queued = v.queued === true;
  const position =
    queued &&
    typeof v.position === 'number' &&
    Number.isInteger(v.position) &&
    v.position > 0
      ? v.position
      : null;
  return { message: pickId(v.message, NAME_MAX), queued, position };
}

/** Spaces one computer's `list_spaces` answer is read for, at most. */
export const COMPUTER_SPACES_MAX = 50;

/** A space id a host issues (12 hex, or an `rs_` id): what may name a route. */
const LOCAL_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** One row of a computer's `list_spaces` answer, before it gets its host. */
export interface ListedSpace {
  space: string;
  name: string;
  title: string;
  project: string;
  status: string;
  mode: FleetMode | null;
  activeAt: number;
}

/**
 * The host's `ok` value for `list_spaces` as the list takes it, field by
 * field (`crates/ports/src/local_spaces.rs` `LocalSpaceList`): at most
 * COMPUTER_SPACES_MAX rows, ids that may name a route, known statuses.
 * Left out: archived and done ones, mirrors of spaces running on another
 * device (`remote`), and sub-spaces (shown under their parent).
 */
export function listedSpacesOf(value: unknown): ListedSpace[] {
  if (!isObj(value) || !Array.isArray(value.spaces)) return [];
  return value.spaces
    .slice(0, COMPUTER_SPACES_MAX)
    .filter(isObj)
    .filter(
      (s) =>
        typeof s.space === 'string' &&
        LOCAL_ID.test(s.space) &&
        s.remote !== true &&
        s.done !== true &&
        !s.parent &&
        s.status !== 'archived',
    )
    .map((s) => ({
      space: s.space as string,
      name: str(s.name, NAME_MAX),
      title: str(s.title, NAME_MAX) || str(s.name, NAME_MAX),
      project: str(s.project, NAME_MAX),
      status: (READ_STATUSES as readonly unknown[]).includes(s.status)
        ? (s.status as string)
        : 'unknown',
      mode: isMode(s.mode) ? s.mode : null,
      activeAt: num(s.updated_at),
    }));
}

/** One `my_spaces` row as the list takes it; `null` when it can't be one. */
export interface CloudSpace {
  space: string;
  hostDevice: string;
  originDevice: string;
  /** The cloud's copy of the host-signed `started` name: a placeholder. */
  name: string;
  mode: FleetMode | null;
  status: SpaceStatus | null;
  lastMs: number;
}

/**
 * A `my_spaces` row, shape-checked: the cloud's word, unsigned, so only
 * what lists the space and subscribes to it is kept, every text cut.
 */
export function cloudSpaceOf(v: unknown): CloudSpace | null {
  if (!isObj(v)) return null;
  if (typeof v.space !== 'string' || !LOCAL_ID.test(v.space)) return null;
  if (!validDeviceId(v.host_device) || !validDeviceId(v.origin_device))
    return null;
  return {
    space: v.space,
    hostDevice: v.host_device,
    originDevice: v.origin_device,
    name: typeof v.name === 'string' ? truncate(v.name, NAME_MAX) : '',
    mode: isMode(v.mode) ? v.mode : null,
    status: remoteStatus(v.status),
    lastMs: num(v.last_ms),
  };
}
