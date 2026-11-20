/**
 * The local-space tools of `space-tools` (docs/spaces.md "Sub-spaces, and
 * asking other spaces") as a parent's timeline reads them: what the agent
 * did to which space, by name, with where that space stands now. Pure: the
 * row draws `spaceToolView`.
 *
 * ```text
 * step (label or raw name) ─▶ spaceToolOf ─▶ start | wait | merge | ask | …
 * payload (input, result) ──┐
 * the store, by space id ───┴─▶ spaceToolView ─▶ "Sub-space started: <title>"
 *                                                 + its stage, live
 * ```
 *
 * | Tool | running | done | failed |
 * | --- | --- | --- | --- |
 * | start | Starting a sub-space: <goal> | Sub-space started: <title> | Start a sub-space |
 * | wait | Waiting for N sub-spaces + live counts | Waited for N sub-spaces + what settled | Wait for … |
 * | merge | Merging <child> | Merged <child> + / − , N conflicts to resolve | Merge <child> |
 * | ask | Asking <space>: <question> | Asked <space>: <question> | Ask <space>: … |
 * | send | Sending to <space>: <message> | Sent to <space>: <message> | Send to … |
 * | answer | Answering <space>'s question | Answered <space>'s question | Answer … |
 * | read, list, stop | Reading … | Read <space>, Listed spaces, Stopped <child> | Read … |
 */
import type { Space, ToolPayload } from '../gen/contract';
import {
  CHILD_STAGE_LABEL,
  childStage,
  type ChildStage,
  type StageFields,
} from './space/subspaces';
import { spaceTitle } from './space/spaces';

export type SpaceTool =
  | 'start'
  | 'wait'
  | 'merge'
  | 'ask'
  | 'send'
  | 'answer'
  | 'read'
  | 'list'
  | 'stop';

/** What the core labels them (`tool_label`). */
const BY_LABEL: Record<string, SpaceTool> = {
  'start a sub-space': 'start',
  'wait for sub-spaces': 'wait',
  'merge a sub-space': 'merge',
  'ask a space': 'ask',
  'message a space': 'send',
  'answer a space': 'answer',
  'read a space': 'read',
  'list the spaces': 'list',
  'stop a sub-space': 'stop',
};

/** Their own names: a turn stored before the core labelled them. */
const BY_NAME: Record<string, SpaceTool> = {
  space_start: 'start',
  space_wait: 'wait',
  space_merge: 'merge',
  space_ask: 'ask',
  space_send: 'send',
  space_answer: 'answer',
  space_read: 'read',
  spaces_list: 'list',
  space_stop: 'stop',
};

/** The local-space tool a step's name is: its label, or its own name with
 *  or without the server (`mcp__space-tools__space_start`). */
export function spaceToolOf(name: string): SpaceTool | null {
  if (Object.hasOwn(BY_LABEL, name)) return BY_LABEL[name]!;
  const own = /^(?:mcp__)?space-tools__(\w+)$/.exec(name)?.[1] ?? name;
  return Object.hasOwn(BY_NAME, own) ? BY_NAME[own]! : null;
}

/** How the tool reads in a fold or anywhere a label alone shows. */
export const SPACE_TOOL_LABEL: Record<SpaceTool, string> = {
  start: 'Start a sub-space',
  wait: 'Wait for sub-spaces',
  merge: 'Merge a sub-space',
  ask: 'Ask a space',
  send: 'Message a space',
  answer: 'Answer a space',
  read: 'Read a space',
  list: 'List spaces',
  stop: 'Stop a sub-space',
};

/** Always a row of a finished turn: what the agent did with other spaces.
 *  Reading and listing fold with the rest. */
export const spaceToolPinned = (tool: SpaceTool) =>
  tool !== 'read' && tool !== 'list';

// ── the payload ─────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

export interface SpaceToolData {
  input: Obj | null;
  /** The result's JSON, when it came back as such. */
  result: Obj | null;
}

const isObj = (v: unknown): v is Obj =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** The call's input and its result's JSON (the tools answer in JSON; an
 *  error is plain text, and no result). */
export function spaceToolData(payload: ToolPayload | null): SpaceToolData {
  const input = isObj(payload?.input?.value) ? payload.input.value : null;
  const raw = payload?.result?.ok
    ? (payload.result.output?.text ?? payload.result.stdout?.text ?? null)
    : null;
  let result: Obj | null = null;
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isObj(parsed)) result = parsed;
    } catch {
      result = null;
    }
  }
  return { input, result };
}

const str = (o: Obj | null | undefined, key: string): string | null => {
  const v = o?.[key];
  return typeof v === 'string' && v.trim() ? v : null;
};

const num = (o: Obj | null | undefined, key: string): number | null => {
  const v = o?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

const list = (o: Obj | null | undefined, key: string): unknown[] | null => {
  const v = o?.[key];
  return Array.isArray(v) ? v : null;
};

/** One line of what was said: the row truncates it. */
export const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

// ── the view ────────────────────────────────────────────────────────────────

/** What the row knows of a space here. */
export type SpaceLike = StageFields &
  Pick<Space, 'id' | 'goal' | 'name' | 'title' | 'mode'>;

export type SpaceLookup = (id: string) => SpaceLike | undefined;

export interface SpaceRef {
  /** `null`: not started yet, nothing to open. */
  id: string | null;
  title: string;
  /** In the store here: the name opens it. */
  known: boolean;
}

export type Phase = 'running' | 'done' | 'failed';

export interface SpaceToolView {
  tool: SpaceTool;
  phase: Phase;
  /** Before the space's name. */
  label: string;
  space: SpaceRef | null;
  /** After the name: `'s question`. */
  after: string | null;
  /** What was asked or sent, one line; muted after the row's words. */
  text: string | null;
  /** The started child's stage, live. */
  stage: ChildStage | null;
  /** Muted: the child's mode, the wait's counts, a merge's files. */
  note: string | null;
  added: number | null;
  removed: number | null;
  /** Files a merge left with conflict markers. */
  conflicts: number;
}

const MODE: Record<Space['mode'], string> = {
  ask: 'Ask',
  plan: 'Plan',
  edit: 'Edit',
  run: 'Run',
};

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** Where a call stands: still going, done, or failed (no result before
 *  the turn ended counts as not done). */
export function phaseOf(ok: boolean | null, running: boolean): Phase {
  if (ok === true) return 'done';
  if (ok == null && running) return 'running';
  return 'failed';
}

/** A space the call names, by its id: its title here, else what the
 *  result called it, else the id. */
function refOf(
  id: string | null,
  lookup: SpaceLookup,
  named: string | null = null,
): SpaceRef | null {
  if (!id) return named ? { id: null, title: named, known: false } : null;
  const s = lookup(id);
  if (s) return { id, title: spaceTitle(s), known: true };
  return { id, title: named ?? id, known: false };
}

/** The space a result describes (`space` holds a space item, or its id). */
function resultSpace(result: Obj | null): {
  id: string | null;
  title: string | null;
} {
  const item = result?.space;
  if (isObj(item)) {
    return { id: str(item, 'space'), title: str(item, 'title') };
  }
  return { id: str(result, 'space'), title: str(result, 'title') };
}

/** The settled spaces of a `space_wait` result, as "A done, B waiting for
 *  you". */
function settledLine(result: Obj | null, lookup: SpaceLookup): string | null {
  const settled = list(result, 'settled');
  if (!settled) return null;
  if (settled.length === 0) return 'none settled';
  const items = (list(result, 'spaces') ?? []).filter(isObj);
  return settled
    .filter((id): id is string => typeof id === 'string')
    .map((id) => {
      const item = items.find((i) => str(i, 'space') === id);
      const title = refOf(id, lookup, str(item, 'title'))!.title;
      const status = str(item, 'status');
      const word =
        status === 'question'
          ? 'waiting for you'
          : status === 'failed'
            ? 'failed'
            : 'done';
      return `${title} ${word}`;
    })
    .join(', ');
}

/** Where the spaces waited on stand now: "1 done · 2 running · 1 waiting
 *  for you". */
export function waitCounts(
  ids: readonly string[],
  lookup: SpaceLookup,
): string | null {
  const stages = ids.flatMap((id) => {
    const s = lookup(id);
    return s ? [childStage(s)] : [];
  });
  if (stages.length === 0) return null;
  const count = (...of: ChildStage[]) =>
    stages.filter((s) => of.includes(s)).length;
  return [
    [count('done', 'merged'), 'done'],
    [count('running', 'starting'), 'running'],
    [count('asking'), 'waiting for you'],
    [count('failed'), 'failed'],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, word]) => `${n} ${word}`)
    .join(' · ');
}

/** What a local-space tool's row says. */
export function spaceToolView(
  tool: SpaceTool,
  step: { ok: boolean | null; target: string | null },
  data: SpaceToolData,
  lookup: SpaceLookup,
  running: boolean,
): SpaceToolView {
  const phase = phaseOf(step.ok, running);
  const { input, result } = data;
  const said = (phrases: Record<Phase, string>) => phrases[phase];
  const view: SpaceToolView = {
    tool,
    phase,
    label: '',
    space: null,
    after: null,
    text: null,
    stage: null,
    note: null,
    added: null,
    removed: null,
    conflicts: 0,
  };
  // The space it acts on: its input's `space`, which the step's target is.
  const target = str(input, 'space') ?? step.target;
  switch (tool) {
    case 'start': {
      const made = resultSpace(result);
      const child = made.id ? lookup(made.id) : undefined;
      const goal = str(input, 'goal');
      const provisional = str(input, 'name') ?? (goal && oneLine(goal));
      const space = refOf(made.id, lookup, made.title ?? provisional);
      const mode =
        child?.mode ??
        (str(result, 'mode') as Space['mode'] | null) ??
        (str(input, 'mode') as Space['mode'] | null);
      return {
        ...view,
        label: said({
          running: 'Starting a sub-space',
          done: 'Sub-space started',
          failed: 'Start a sub-space',
        }),
        space,
        stage: child ? childStage(child) : null,
        note: mode && MODE[mode] ? MODE[mode] : null,
      };
    }
    case 'wait': {
      const ids = (list(input, 'spaces') ?? []).filter(
        (id): id is string => typeof id === 'string',
      );
      const n = ids.length || (list(result, 'spaces')?.length ?? 0);
      const what = n ? plural(n, 'sub-space') : 'sub-spaces';
      return {
        ...view,
        label: said({
          running: `Waiting for ${what}`,
          done: `Waited for ${what}`,
          failed: `Wait for ${what}`,
        }),
        note:
          phase === 'running'
            ? waitCounts(ids, lookup)
            : phase === 'done'
              ? settledLine(result, lookup)
              : null,
      };
    }
    case 'merge': {
      const merged = resultSpace(result);
      const files = list(result, 'files');
      const conflicts = list(result, 'conflicts')?.length ?? 0;
      return {
        ...view,
        label: said({ running: 'Merging', done: 'Merged', failed: 'Merge' }),
        space: refOf(target ?? merged.id, lookup, merged.title),
        note: files ? plural(files.length, 'file') : null,
        added: num(result, 'additions'),
        removed: num(result, 'deletions'),
        conflicts,
      };
    }
    case 'ask': {
      const asked = resultSpace(result);
      const question = str(input, 'question');
      return {
        ...view,
        label: said({ running: 'Asking', done: 'Asked', failed: 'Ask' }),
        space: refOf(target, lookup, asked.title),
        text: question && oneLine(question),
      };
    }
    case 'send': {
      const message = str(input, 'message');
      return {
        ...view,
        label: said({
          running: 'Sending to',
          done: 'Sent to',
          failed: 'Send to',
        }),
        space: refOf(target, lookup, resultSpace(result).title),
        text: message && oneLine(message),
      };
    }
    case 'answer':
      return {
        ...view,
        label: said({
          running: 'Answering',
          done: 'Answered',
          failed: 'Answer',
        }),
        space: refOf(target, lookup, resultSpace(result).title),
        after: "'s question",
      };
    case 'read':
      return {
        ...view,
        label: said({ running: 'Reading', done: 'Read', failed: 'Read' }),
        space: refOf(target, lookup, resultSpace(result).title),
      };
    case 'list': {
      const listed = list(result, 'spaces');
      return {
        ...view,
        label: said({
          running: 'Listing spaces',
          done: 'Listed spaces',
          failed: 'List spaces',
        }),
        note:
          phase === 'done' && listed ? plural(listed.length, 'space') : null,
      };
    }
    case 'stop':
      return {
        ...view,
        label: said({
          running: 'Stopping',
          done: 'Stopped',
          failed: 'Stop',
        }),
        space: refOf(target, lookup, resultSpace(result).title),
      };
  }
}

/** The row's words in one line, for a title or a test. */
export function spaceToolLine(v: SpaceToolView): string {
  const name = v.space ? ` ${v.space.title}` : '';
  const head =
    v.tool === 'start' && v.space ? `${v.label}:${name}` : `${v.label}${name}`;
  return `${head}${v.after ?? ''}${v.text ? `: ${v.text}` : ''}`;
}

/** The stage chip's word. */
export const stageWord = (stage: ChildStage) => CHILD_STAGE_LABEL[stage];

/** A merge's files, from its result, for the opened row. */
export interface MergedFile {
  path: string;
  additions: number;
  deletions: number;
  conflict: boolean;
}

export function mergedFiles(result: Obj | null): MergedFile[] {
  const conflicts = new Set(
    (list(result, 'conflicts') ?? []).filter(
      (p): p is string => typeof p === 'string',
    ),
  );
  const files = (list(result, 'files') ?? []).filter(isObj).map((f) => ({
    path: str(f, 'path') ?? '',
    additions: num(f, 'additions') ?? 0,
    deletions: num(f, 'deletions') ?? 0,
    conflict: conflicts.has(str(f, 'path') ?? ''),
  }));
  // A conflict in a file the merge didn't list still needs resolving.
  for (const path of conflicts) {
    if (!files.some((f) => f.path === path)) {
      files.push({ path, additions: 0, deletions: 0, conflict: true });
    }
  }
  return files.filter((f) => f.path);
}

/** An ask's answer, and who gave it: "claude · fork". */
export function askAnswer(
  result: Obj | null,
): { answer: string; by: string | null } | null {
  const answer = str(result, 'answer');
  if (!answer) return null;
  const by = [str(result, 'agent'), str(result, 'model'), str(result, 'how')]
    .filter(Boolean)
    .join(' · ');
  return { answer, by: by || null };
}
