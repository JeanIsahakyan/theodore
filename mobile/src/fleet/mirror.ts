/**
 * A followed space's mirrored rows (docs/fleet.md "One space UI: mirrored
 * rows"): the host's own `space` row, its chat, and the running turn's live
 * steps. Applied only after the event that carries them verified against
 * the host's pin; shape-checked here, since a row is still text from another
 * device.
 *
 * ```text
 * mirror{space, rs_…, Space}             ─▶ space row (null: gone)
 *   not running                          ─▶ live steps dropped
 * mirror{chat_message, id, ChatMessage}  ─▶ messages[id] (null: deleted)
 *   an agent reply of run R              ─▶ R's live steps dropped
 * mirror{turn_step, <run>:<n>, TurnStep} ─▶ steps[id] while R has no reply
 * mirror{sub_space, <child id>, MirroredSubSpace}
 *                                        ─▶ subSpaces[id] (null: gone), latest wins
 * ```
 */
import type {
  Attachment,
  Author,
  ChatMessage,
  Space,
  SpaceMode,
  SpaceProgress,
  SpaceQuestion,
  SpaceStatusRow,
  SpaceTurn,
  TurnFile,
  TurnStep,
} from './contract';
import type { MirroredSubSpace } from '../gen/fleet';
import { truncate } from './rules';
import type { SpaceStatus } from './types';

export interface LiveStep {
  run: string;
  n: number;
  step: TurnStep;
}

export interface SpaceMirror {
  space: Space | null;
  messages: Record<string, ChatMessage>;
  /** The running turn's steps by `<run>:<n>`, until its reply lands. */
  steps: Record<string, LiveStep>;
  /**
   * Its sub-spaces on the host (`mirror{sub_space}`), children and theirs,
   * by local id, in the order first seen.
   */
  subSpaces: Record<string, MirroredSubSpace>;
}

export const emptyMirror = (): SpaceMirror => ({
  space: null,
  messages: {},
  steps: {},
  subSpaces: {},
});

/** The `mirror` model of a hosted space's sub-space (protocol 7). */
export const SUB_SPACE_MODEL = 'sub_space';
/** Most sub-spaces kept per space (the cloud's MCP keeps as many). */
export const SUB_SPACES_KEPT = 50;

/** Most messages kept per space (oldest go first). */
export const MESSAGES_KEPT = 2000;
/** Most live steps kept per space. */
export const STEPS_KEPT = 1000;
/** Most steps kept in a reply's activity. */
const ACTIVITY_KEPT = 1000;
/** A host cuts a row at 48 KiB; nothing longer is taken. */
const TEXT_MAX = 64 * 1024;
const LINE_MAX = 4000;
const NAME_MAX = 200;

/** The chat key of a fleet space's rows (`ChatMessage.pr`). */
export const chatKey = (space: string): string => `space:${space}`;

// ── shape checks ────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max: number): string =>
  typeof v === 'string' ? truncate(v, max) : '';
const optStr = (v: unknown, max: number): string | null =>
  typeof v === 'string' ? truncate(v, max) : null;
const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;
const optNum = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const MODES: readonly SpaceMode[] = ['ask', 'plan', 'edit', 'run'];
const mode = (v: unknown): SpaceMode | null =>
  MODES.includes(v as SpaceMode) ? (v as SpaceMode) : null;
const ROW_STATUSES: readonly SpaceStatusRow[] = [
  'idle',
  'running',
  'failed',
  'archived',
];
const strings = (v: unknown, count: number, max: number): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === 'string')
        .slice(0, count)
        .map((x) => truncate(x, max))
    : [];

export function cleanStep(v: unknown): TurnStep | null {
  if (!isObj(v)) return null;
  const parent = optStr(v.parent, NAME_MAX);
  if (v.kind === 'text' || v.kind === 'thinking') {
    return { kind: v.kind, text: str(v.text, TEXT_MAX), parent };
  }
  if (v.kind !== 'tool' || typeof v.name !== 'string') return null;
  return {
    kind: 'tool',
    name: truncate(v.name, NAME_MAX),
    target: optStr(v.target, LINE_MAX),
    ok: typeof v.ok === 'boolean' ? v.ok : null,
    id: optStr(v.id, NAME_MAX),
    parent,
    detail: optStr(v.detail, LINE_MAX),
    summary: optStr(v.summary, LINE_MAX),
    added: optNum(v.added),
    removed: optNum(v.removed),
    background: v.background === true,
  };
}

function cleanAuthor(v: unknown): Author | null {
  if (!isObj(v)) return null;
  if (v.kind === 'me') return { kind: 'me' };
  if (v.kind === 'agent') return { kind: 'agent', agent: str(v.agent, 40) };
  return null;
}

function cleanFiles(v: unknown): TurnFile[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(isObj)
    .filter((f) => typeof f.path === 'string')
    .slice(0, 200)
    .map((f) => ({
      path: str(f.path, 1000),
      additions: num(f.additions),
      deletions: num(f.deletions),
    }));
}

function cleanAttachments(v: unknown): Attachment[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(isObj)
    .slice(0, 20)
    .map((a) => ({
      id: str(a.id, NAME_MAX),
      name: str(a.name, NAME_MAX),
      mime: str(a.mime, 100),
      size: num(a.size),
    }));
}

export function cleanMessage(v: unknown, space: string): ChatMessage | null {
  if (!isObj(v) || typeof v.id !== 'string') return null;
  if (v.pr !== chatKey(space)) return null;
  const author = cleanAuthor(v.author);
  if (!author) return null;
  const activity = Array.isArray(v.activity)
    ? v.activity
        .slice(0, ACTIVITY_KEPT)
        .map(cleanStep)
        .filter((s): s is TurnStep => s !== null)
    : [];
  return {
    id: truncate(v.id, NAME_MAX),
    pr: chatKey(space),
    author,
    text: str(v.text, TEXT_MAX),
    at: num(v.at),
    failed: optStr(v.failed, LINE_MAX),
    attachments: cleanAttachments(v.attachments),
    queued: isObj(v.queued)
      ? { seq: num(v.queued.seq), held: v.queued.held === true }
      : null,
    from_tasks: strings(v.from_tasks, 20, 500),
    activity,
    duration_ms: optNum(v.duration_ms),
    changed_files: cleanFiles(v.changed_files),
    model: optStr(v.model, NAME_MAX),
    text_in_steps: v.text_in_steps === true,
    run: optStr(v.run, NAME_MAX),
    mode: mode(v.mode),
  };
}

function cleanQuestion(v: unknown): SpaceQuestion | null {
  if (!isObj(v) || typeof v.id !== 'string' || !Array.isArray(v.questions))
    return null;
  return {
    id: truncate(v.id, NAME_MAX),
    run: str(v.run, NAME_MAX),
    questions: v.questions
      .filter(isObj)
      .slice(0, 20)
      .map((q) => ({
        question: str(q.question, 2000),
        options: strings(q.options, 20, 500),
        multi: q.multi === true,
      })),
    asked_at: num(v.asked_at),
  };
}

function cleanTurns(v: unknown): SpaceTurn[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(isObj)
    .slice(-500)
    .map((t) => ({
      message: str(t.message, NAME_MAX),
      reply: str(t.reply, NAME_MAX),
      undone: t.undone === true,
      steered: strings(t.steered, 50, NAME_MAX),
      plan: optStr(t.plan, TEXT_MAX),
      stopped: t.stopped === true,
    }));
}

function cleanProgress(v: unknown): SpaceProgress | null {
  if (!isObj(v) || !Array.isArray(v.steps)) return null;
  const states = ['pending', 'active', 'done'] as const;
  return {
    steps: v.steps
      .filter(isObj)
      .slice(0, 50)
      .map((s) => ({
        label: str(s.label, 500),
        state: states.includes(s.state as (typeof states)[number])
          ? (s.state as (typeof states)[number])
          : 'pending',
      })),
    note: optStr(v.note, 500),
    at: num(v.at),
  };
}

export function cleanSpace(v: unknown, space: string): Space | null {
  if (!isObj(v) || v.id !== space) return null;
  return {
    id: space,
    name: str(v.name, NAME_MAX),
    goal: str(v.goal, TEXT_MAX),
    branch: str(v.branch, NAME_MAX),
    base_sha: str(v.base_sha, 64),
    head_sha: str(v.head_sha, 64),
    status: ROW_STATUSES.includes(v.status as SpaceStatusRow)
      ? (v.status as SpaceStatusRow)
      : 'idle',
    agent: str(v.agent, 40),
    model: optStr(v.model, NAME_MAX),
    effort: optStr(v.effort, 16),
    mode: mode(v.mode) ?? 'edit',
    turns: num(v.turns),
    run: optStr(v.run, NAME_MAX),
    pr: optStr(v.pr, NAME_MAX),
    shipped: isObj(v.shipped)
      ? {
          how: str(v.shipped.how, 40),
          branch: str(v.shipped.branch, NAME_MAX),
          sha: str(v.shipped.sha, 64),
        }
      : null,
    error: optStr(v.error, LINE_MAX),
    turn_log: cleanTurns(v.turn_log),
    title: optStr(v.title, NAME_MAX),
    progress: cleanProgress(v.progress),
    build_mode: mode(v.build_mode),
    question: cleanQuestion(v.question),
    blank: v.blank === true,
    created_at: num(v.created_at),
    updated_at: num(v.updated_at),
  };
}

/** An id a host gives a space: its 12-hex local id, an `rs_` id, alike. */
const spaceId = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v);

/** A sub-space row of `space`'s tree; `null` when it isn't child `id`. */
export function cleanSubSpace(
  v: unknown,
  id: string,
  space: string,
): MirroredSubSpace | null {
  if (!isObj(v) || v.space !== id || id === space || !spaceId(id)) return null;
  if (!spaceId(v.parent) || v.parent === id) return null;
  const m = mode(v.mode);
  if (!m) return null;
  return {
    space: id,
    parent: v.parent,
    title: str(v.title, 120),
    status: typeof v.status === 'string' ? truncate(v.status, 20) : 'unknown',
    mode: m,
    done: v.done === true,
  };
}

/** `<run>:<n>` → its run and place; `null` when it isn't one of `space`'s. */
export function stepId(
  id: string,
  space: string,
): { run: string; n: number } | null {
  const at = id.lastIndexOf(':');
  if (at <= 0) return null;
  const run = id.slice(0, at);
  const n = Number(id.slice(at + 1));
  if (!Number.isInteger(n) || n < 0) return null;
  if (!run.startsWith(`${chatKey(space)}:`)) return null;
  return { run, n };
}

// ── the reducer ─────────────────────────────────────────────────────────────

const without = <T>(
  rec: Record<string, T>,
  drop: (v: T, k: string) => boolean,
): Record<string, T> => {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(rec)) if (!drop(v, k)) out[k] = v;
  return out;
};

const replied = (m: SpaceMirror, run: string) =>
  Object.values(m.messages).some(
    (x) => x.author.kind === 'agent' && x.run === run,
  );

/**
 * One verified `mirror{model, id, data}` of `space`, applied to `m`. A new
 * object when it changed something, `m` itself when it was dropped.
 */
export function applyMirror(
  m: SpaceMirror,
  space: string,
  model: unknown,
  id: unknown,
  data: unknown,
): SpaceMirror {
  if (typeof id !== 'string' || !id) return m;
  switch (model) {
    case 'space': {
      if (id !== space) return m;
      if (data == null) return { ...m, space: null };
      const row = cleanSpace(data, space);
      if (!row) return m;
      const steps = row.status === 'running' ? m.steps : {};
      return { ...m, space: row, steps };
    }
    case 'chat_message': {
      if (data == null) {
        if (!(id in m.messages)) return m;
        return { ...m, messages: without(m.messages, (_, k) => k === id) };
      }
      const msg = cleanMessage(data, space);
      if (!msg || msg.id !== id) return m;
      let messages: Record<string, ChatMessage> = {
        ...m.messages,
        [id]: msg,
      };
      const ids = Object.keys(messages);
      if (ids.length > MESSAGES_KEPT) {
        const old = new Set(
          sortMessages(Object.values(messages))
            .slice(0, ids.length - MESSAGES_KEPT)
            .map((x) => x.id),
        );
        messages = without(messages, (_, k) => old.has(k));
      }
      const run = msg.author.kind === 'agent' ? msg.run : null;
      const steps = run ? without(m.steps, (s) => s.run === run) : m.steps;
      return { ...m, messages, steps };
    }
    case 'turn_step': {
      const where = stepId(id, space);
      if (!where) return m;
      if (data == null) {
        if (!(id in m.steps)) return m;
        return { ...m, steps: without(m.steps, (_, k) => k === id) };
      }
      // A step bare, or `{run, step}` around it.
      const raw = isObj(data) && isObj(data.step) ? data.step : data;
      const step = cleanStep(raw);
      if (!step || replied(m, where.run)) return m;
      let steps: Record<string, LiveStep> = {
        ...m.steps,
        [id]: { ...where, step },
      };
      const keys = Object.keys(steps);
      if (keys.length > STEPS_KEPT) {
        const old = new Set(
          Object.entries(steps)
            .sort(
              ([, a], [, b]) =>
                Number(a.run === where.run) - Number(b.run === where.run) ||
                a.n - b.n,
            )
            .slice(0, keys.length - STEPS_KEPT)
            .map(([k]) => k),
        );
        steps = without(steps, (_, k) => old.has(k));
      }
      return { ...m, steps };
    }
    case SUB_SPACE_MODEL: {
      if (data == null) {
        if (!(id in m.subSpaces)) return m;
        return {
          ...m,
          subSpaces: without(m.subSpaces, (_, k) => k === id),
        };
      }
      const sub = cleanSubSpace(data, id, space);
      if (!sub) return m;
      const known = id in m.subSpaces;
      if (!known && Object.keys(m.subSpaces).length >= SUB_SPACES_KEPT)
        return m;
      return { ...m, subSpaces: { ...m.subSpaces, [id]: sub } };
    }
    default:
      return m;
  }
}

// ── reading it ──────────────────────────────────────────────────────────────

/** Oldest first; `at` ties by id. */
export function sortMessages(list: readonly ChatMessage[]): ChatMessage[] {
  return [...list].sort(
    (a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** The host sent rows to show: the chat is the mirror's, not the lines. */
export const mirrored = (m: SpaceMirror | null | undefined): boolean =>
  !!m && (m.space !== null || Object.keys(m.messages).length > 0);

/** The space row's status as the list says it. */
export function mirrorStatus(s: Space): SpaceStatus {
  switch (s.status) {
    case 'running':
      return s.question ? 'waiting' : 'running';
    case 'archived':
      return 'stopped';
    default:
      return s.status;
  }
}

/** The desktop's title for a space: the agent's short title, else the goal's
 *  first line, else its name or branch; cut near 60 characters. */
export function mirrorTitle(
  s: Pick<Space, 'goal' | 'name' | 'title' | 'branch'>,
): string {
  const proposed = s.title?.trim();
  const line = s.goal
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const placeholder = /^space(-\d+)?$/.test(s.name);
  const raw =
    proposed || line || (placeholder && s.branch.trim()) || s.name || s.branch;
  const t = raw.replace(/[.。!]+$/u, '');
  if (t.length <= 60) return t;
  const cut = t.slice(0, 60);
  const word = cut.lastIndexOf(' ');
  return `${(word > 30 ? cut.slice(0, word) : cut).replace(/[,;:]$/, '')}…`;
}

/** The newest agent reply's text, for the list's excerpt. */
export function latestReply(m: SpaceMirror): string | null {
  const replies = sortMessages(Object.values(m.messages)).filter(
    (x) => x.author.kind === 'agent' && !x.failed && x.text.trim(),
  );
  return replies.at(-1)?.text ?? null;
}

/** A run's live steps, in order. */
export function liveSteps(m: SpaceMirror, run: string | null): TurnStep[] {
  if (!run) return [];
  return Object.values(m.steps)
    .filter((s) => s.run === run)
    .sort((a, b) => a.n - b.n)
    .map((s) => s.step);
}

/** The run live steps belong to when the space row doesn't say: the one
 *  with the newest step. */
export function newestStepRun(m: SpaceMirror): string | null {
  let best: LiveStep | null = null;
  for (const s of Object.values(m.steps)) if (!best || s.n >= best.n) best = s;
  return best?.run ?? null;
}
