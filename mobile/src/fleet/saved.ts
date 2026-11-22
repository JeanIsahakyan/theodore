/**
 * The spaces this device started or follows, kept across restarts (the
 * desktop's kv `fleet.follow:<rs_>`, `crates/app/src/usecases/fleet_follow.rs`).
 * One set per account and organization; iOS kills a backgrounded app at
 * will, and the list must not come back empty.
 *
 * ```text
 * <data storage>
 *   theodore.fleet.spaces.<user>.<org>        index {v, device, spaces: [ids, list order]}
 *   theodore.fleet.space.<user>.<org>.<rs_…>  record {v, view, lastSeq, seenAt, lines,
 *                                                     mirror {space, messages, subSpaces}}
 *
 * write: the SAVED_MAX most recently active, records of the others removed
 * load:  index.device ≠ this org's device id now (backup on another phone,
 *        removed from the fleet) ─▶ nothing, all removed
 *        each record shape-checked again (it is still another device's text)
 * ```
 *
 * A record keeps the list's view, the last seq seen (the resubscribe's
 * `since`), the newest lines and mirrored messages, the space row and its
 * sub-spaces: the list and the chat show at once, the cloud replays what
 * came after.
 */
import type { MirroredSubSpace } from '../gen/fleet';
import type { ChatMessage, Space } from './contract';
import type { DataStorage } from './data';
import {
  SUB_SPACES_KEPT,
  cleanMessage,
  cleanSpace,
  cleanSubSpace,
  sortMessages,
} from './mirror';
import { isMode, truncate, validDeviceId } from './rules';
import type {
  LineKind,
  QuestionView,
  SpaceLine,
  SpaceStatus,
  SpaceView,
} from './types';
import { storageKey } from '../keys/storage-types';

/** Most spaces kept (most recently active first). */
export const SAVED_MAX = 50;
/** Newest mirrored messages kept per space. */
export const SAVED_MESSAGES = 100;
/** Newest lines kept per space. */
export const SAVED_LINES = 100;
/** A record longer than this (characters of JSON) drops messages, then lines. */
export const SAVED_CHARS = 512 * 1024;

const VERSION = 1;

export interface SavedSpace {
  view: SpaceView;
  lastSeq: number;
  /** The signed `started` name (questions' "<host> · <name>"). */
  startedName: string | null;
  /** Last time something of it arrived (or it was started / followed). */
  seenAt: number;
  lines: SpaceLine[];
  mirror: {
    space: Space | null;
    messages: ChatMessage[];
    /** Its sub-spaces, in the order first seen; absent in older records. */
    subSpaces?: MirroredSubSpace[];
  };
}

/** Ids that may name a file: what a host issues (`rs_` + hex) and alike. */
export const savable = (space: string): boolean =>
  /^[A-Za-z0-9_-]{1,100}$/.test(space);

/** Account and organization a set belongs to. */
export const savedScope = (userId: string, orgId: string): string =>
  storageKey(userId, orgId);

const indexKey = (scope: string) => `theodore.fleet.spaces.${scope}`;
const recordKey = (scope: string, space: string) =>
  `theodore.fleet.space.${scope}.${space}`;

interface Index {
  v: number;
  device: string;
  spaces: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max: number): string =>
  typeof v === 'string' ? truncate(v, max) : '';
const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
const parse = (text: string | null): unknown => {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const STATUSES: readonly SpaceStatus[] = [
  'starting',
  'running',
  'idle',
  'waiting',
  'stopped',
  'failed',
];
const LINE_KINDS: readonly LineKind[] = [
  'started',
  'status',
  'turn',
  'tool',
  'reply',
  'ended',
  'question',
  'gap',
];

function cleanQuestion(v: unknown, space: string): QuestionView | null {
  if (!isObj(v) || typeof v.askId !== 'string' || !Array.isArray(v.questions))
    return null;
  return {
    askId: truncate(v.askId, 200),
    space,
    from: str(v.from, 300),
    questions: v.questions
      .filter(isObj)
      .slice(0, 20)
      .map((q) => ({
        question: str(q.question, 2000),
        options: Array.isArray(q.options)
          ? q.options
              .filter((o): o is string => typeof o === 'string')
              .slice(0, 20)
              .map((o) => truncate(o, 500))
          : [],
        multi: q.multi === true,
      })),
  };
}

function cleanView(v: unknown, space: string): SpaceView | null {
  if (!isObj(v) || v.space !== space || !validDeviceId(v.hostDevice))
    return null;
  return {
    space,
    hostDevice: v.hostDevice,
    hostName: str(v.hostName, 100),
    originDevice: validDeviceId(v.originDevice) ? v.originDevice : '',
    projectName: str(v.projectName, 200),
    name: str(v.name, 200),
    branch: str(v.branch, 200),
    status: STATUSES.includes(v.status as SpaceStatus)
      ? (v.status as SpaceStatus)
      : 'idle',
    mode: isMode(v.mode) ? v.mode : 'ask',
    lastReply:
      typeof v.lastReply === 'string' ? truncate(v.lastReply, 8000) : null,
    question: cleanQuestion(v.question, space),
    startedHere: v.startedHere === true,
    error: typeof v.error === 'string' ? truncate(v.error, 300) : null,
  };
}

function cleanLines(v: unknown): SpaceLine[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(isObj)
    .filter((l) => LINE_KINDS.includes(l.kind as LineKind))
    .slice(-SAVED_LINES)
    .map((l) => ({
      seq: num(l.seq),
      kind: l.kind as LineKind,
      text: str(l.text, 8000),
    }));
}

/** A record read back, shape-checked; `null` when it isn't one of `space`. */
export function cleanSaved(v: unknown, space: string): SavedSpace | null {
  if (!isObj(v) || v.v !== VERSION) return null;
  const view = cleanView(v.view, space);
  if (!view) return null;
  const m = isObj(v.mirror) ? v.mirror : {};
  const messages = Array.isArray(m.messages)
    ? m.messages
        .slice(-SAVED_MESSAGES)
        .map((x) => cleanMessage(x, space))
        .filter((x): x is ChatMessage => x !== null)
    : [];
  const subSpaces = Array.isArray(m.subSpaces)
    ? m.subSpaces
        .slice(0, SUB_SPACES_KEPT)
        .map((x) =>
          isObj(x) ? cleanSubSpace(x, String(x.space), space) : null,
        )
        .filter((x): x is MirroredSubSpace => x !== null)
    : [];
  return {
    view,
    lastSeq: num(v.lastSeq),
    startedName:
      typeof v.startedName === 'string' ? truncate(v.startedName, 200) : null,
    seenAt: num(v.seenAt),
    lines: cleanLines(v.lines),
    mirror: {
      space: m.space ? cleanSpace(m.space, space) : null,
      messages,
      subSpaces,
    },
  };
}

/** The record as written: the newest messages and lines, within SAVED_CHARS. */
export function recordText(s: SavedSpace): string {
  let messages = sortMessages(s.mirror.messages).slice(-SAVED_MESSAGES);
  let lines = s.lines.slice(-SAVED_LINES);
  let space = s.mirror.space;
  let subSpaces = (s.mirror.subSpaces ?? []).slice(0, SUB_SPACES_KEPT);
  const text = () =>
    JSON.stringify({
      v: VERSION,
      view: s.view,
      lastSeq: s.lastSeq,
      startedName: s.startedName,
      seenAt: s.seenAt,
      lines,
      mirror: { space, messages, subSpaces },
    });
  let out = text();
  while (out.length > SAVED_CHARS && messages.length > 0) {
    messages = messages.slice(Math.ceil(messages.length / 2));
    out = text();
  }
  if (out.length > SAVED_CHARS) {
    lines = [];
    out = text();
  }
  if (out.length > SAVED_CHARS) {
    space = null;
    subSpaces = [];
    out = text();
  }
  return out;
}

export interface SavedSpaces {
  /**
   * The set of `scope` if it was written for `device` (list order); else
   * nothing, and whatever was there is removed.
   */
  load(scope: string, device: string | null): Promise<SavedSpace[]>;
  /**
   * Keeps `spaces` (list order): the SAVED_MAX most recently active. Writes
   * the records in `changed` and any not written yet, removes the dropped.
   */
  write(
    scope: string,
    device: string,
    spaces: SavedSpace[],
    changed: ReadonlySet<string>,
  ): Promise<void>;
  /** Everything of `scope` (sign-out, organization switch). */
  clear(scope: string): Promise<void>;
  /** The ids in `scope`'s set (whatever device it was written for): which
   *  account a notification's space belongs to (`src/push/route.ts`). */
  spacesOf(scope: string): Promise<string[]>;
}

export function savedSpaces(storage: DataStorage): SavedSpaces {
  const readIndex = async (scope: string): Promise<Index | null> => {
    const v = parse(await storage.get(indexKey(scope)).catch(() => null));
    if (!isObj(v) || v.v !== VERSION || typeof v.device !== 'string')
      return null;
    const spaces = Array.isArray(v.spaces)
      ? v.spaces.filter((s): s is string => typeof s === 'string' && savable(s))
      : [];
    return { v: VERSION, device: v.device, spaces };
  };

  const clear = async (scope: string) => {
    const index = await readIndex(scope);
    for (const s of index?.spaces ?? [])
      await storage.remove(recordKey(scope, s)).catch(() => {});
    await storage.remove(indexKey(scope)).catch(() => {});
  };

  return {
    async load(scope, device) {
      const index = await readIndex(scope);
      if (!index) return [];
      if (!device || index.device !== device) {
        await clear(scope);
        return [];
      }
      const out: SavedSpace[] = [];
      for (const space of index.spaces.slice(0, SAVED_MAX)) {
        const text = await storage
          .get(recordKey(scope, space))
          .catch(() => null);
        const rec = cleanSaved(parse(text), space);
        if (rec) out.push(rec);
      }
      return out;
    },

    async write(scope, device, spaces, changed) {
      const ok = spaces.filter((s) => savable(s.view.space));
      const kept = new Set(
        [...ok]
          .sort((a, b) => b.seenAt - a.seenAt)
          .slice(0, SAVED_MAX)
          .map((s) => s.view.space),
      );
      const before = await readIndex(scope);
      const had = new Set(before?.device === device ? before.spaces : []);
      for (const s of ok) {
        const id = s.view.space;
        if (kept.has(id) && (changed.has(id) || !had.has(id)))
          await storage.set(recordKey(scope, id), recordText(s));
      }
      for (const id of before?.spaces ?? [])
        if (!kept.has(id))
          await storage.remove(recordKey(scope, id)).catch(() => {});
      const index: Index = {
        v: VERSION,
        device,
        spaces: ok.map((s) => s.view.space).filter((id) => kept.has(id)),
      };
      await storage.set(indexKey(scope), JSON.stringify(index));
    },

    clear,

    async spacesOf(scope) {
      return (await readIndex(scope))?.spaces ?? [];
    },
  };
}
