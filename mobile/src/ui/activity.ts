/**
 * What a running space is doing, for the strip above its composer and the
 * sheet it opens (docs/mobile.md "Activity strip"), the desktop's rules
 * (`ui/src/ui/space/agents.ts`, `SpaceProgress.tsx`) without React.
 *
 * ```text
 * ⟳ 2 of 5 · Edit auth                 1m 12s   line 1: the plan's active step,
 *                                                else the newest live step or
 *                                                log line, a timer; "· 1 queued"
 * ◌ 2 agents · 2 sub-spaces (1 waiting) ⌃       line 2: the turn's subagents and
 *                                                the space's sub-spaces; opens
 *                                                the sheet
 * ```
 *
 * Subagents are the turn's top-level `Task` / `Agent` calls (`toolRow`
 * kind `agent`): one with no result runs while the turn does; `background`
 * ones without a summary too. Their times are this app's: when a call was
 * first seen, when its result landed.
 */
import type { ChatMessage, SpaceProgress, TurnStep } from '../fleet/contract';
import type { MirroredSubSpace } from '../gen/fleet';
import type { SpaceStatus } from '../fleet/types';
import type { LiveTurn } from './chat';
import {
  subSpaceRows,
  type SubSpaceRow,
  type SubSpaceState,
} from './subSpaceTree';
import { formatDuration, toolRow, toolView, type ToolStep } from './turnRows';

// ── the turn the strip reads ────────────────────────────────────────────────

export interface TurnSource {
  steps: readonly TurnStep[];
  /** The turn is still going: a call with no result runs. */
  running: boolean;
}

/** The running turn's live steps, else the last reply that has any. */
export function turnSource(
  live: LiveTurn | null,
  messages: readonly ChatMessage[],
): TurnSource | null {
  if (live) return { steps: live.steps, running: true };
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.author.kind === 'agent' && m.activity?.length) {
      return { steps: m.activity, running: false };
    }
  }
  return null;
}

// ── subagents ───────────────────────────────────────────────────────────────

export type SubagentStatus = 'running' | 'done' | 'failed';

export interface SubagentView {
  /** Its call id. */
  call: string;
  description: string;
  status: SubagentStatus;
}

const isTool = (s: TurnStep): s is ToolStep => s.kind === 'tool';

/** The top-level subagents in `steps`, in the order they started. A
 *  subagent's own calls (`parent` set) stay out. */
export function subagentsOf(
  steps: readonly TurnStep[],
  running: boolean,
): SubagentView[] {
  const out: SubagentView[] = [];
  for (const s of steps) {
    if (!isTool(s) || s.parent || !s.id) continue;
    if (toolRow(s.name).kind !== 'agent') continue;
    const waiting = !!s.background && !s.summary;
    let status: SubagentStatus;
    if (running && (s.ok == null || waiting)) status = 'running';
    else if (s.ok === false) status = 'failed';
    else status = 'done';
    out.push({
      call: s.id,
      description: s.detail?.trim() || 'Subagent',
      status,
    });
  }
  return out;
}

/** When a call was first seen here and when it ended, by call id. */
export type AgentTimes = Readonly<
  Record<string, { start: number; end?: number }>
>;

/** `times` brought up to `now`: a new call starts now, a running one that
 *  settled ends now; what's known stays. The same object when unchanged. */
export function trackTimes(
  times: AgentTimes,
  agents: readonly SubagentView[],
  now: number,
): AgentTimes {
  let next: Record<string, { start: number; end?: number }> | null = null;
  for (const a of agents) {
    const t = times[a.call];
    if (!t) {
      next ??= { ...times };
      next[a.call] =
        a.status === 'running' ? { start: now } : { start: now, end: now };
    } else if (a.status !== 'running' && t.end === undefined) {
      next ??= { ...times };
      next[a.call] = { start: t.start, end: now };
    }
  }
  return next ?? times;
}

/** "running · 32s", "done · 1m 4s", "failed". */
export function subagentLabel(
  a: SubagentView,
  times: AgentTimes,
  now: number,
): string {
  const t = times[a.call];
  const elapsed = t ? Math.max(0, (t.end ?? now) - t.start) : null;
  // A finished one seen only finished: no time to tell.
  const shown =
    elapsed !== null && !(a.status !== 'running' && t?.end === t?.start);
  return shown ? `${a.status} · ${formatDuration(elapsed)}` : a.status;
}

// ── line 1 ──────────────────────────────────────────────────────────────────

export interface ActivityLine {
  text: string;
  /** Running: a timer after the text, a spinner before it. */
  live: boolean;
  /** "Waiting for your answer ↓": a tap scrolls to the question. */
  waiting: boolean;
}

/** The plan's progress and its active step: "2 of 5 · Edit auth". */
export function progressLabel(p: SpaceProgress): string {
  const done = p.steps.filter((s) => s.state === 'done').length;
  const active = p.steps.find((s) => s.state === 'active')?.label.trim();
  const head = `${done} of ${p.steps.length}`;
  return active ? `${head} · ${active}` : p.note ? `${head} · ${p.note}` : head;
}

/** What a live step reads as, one line: "Edit auth.ts", "Run pnpm test". */
export function stepLabel(step: TurnStep): string | null {
  if (step.kind === 'tool') {
    const v = toolView(step, true);
    return v.chip ? `${v.label} ${v.chip}` : v.label;
  }
  if (step.kind === 'thinking') return 'Thinking';
  const text = step.text.trim();
  return text ? firstLine(text) : null;
}

const firstLine = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? '';

/**
 * Line 1 of the strip; `null` when nothing runs. While the space runs:
 * the plan, else the newest live step, else the newest log line (a host
 * that doesn't mirror), else "Working"; "· N queued" after it.
 */
export function activityLine(input: {
  status: SpaceStatus;
  /** A question waits (the space's, or one routed here). */
  question: boolean;
  progress: SpaceProgress | null;
  liveSteps: readonly TurnStep[];
  /** The newest line of the log, for a host that doesn't mirror. */
  lastLog: string | null;
  queued: number;
}): ActivityLine | null {
  if (input.question && input.status !== 'running') {
    return { text: 'Waiting for your answer ↓', live: false, waiting: true };
  }
  if (input.status !== 'running') return null;
  let text: string;
  if (input.progress && input.progress.steps.length > 0) {
    text = progressLabel(input.progress);
  } else {
    const newest = [...input.liveSteps]
      .reverse()
      .map(stepLabel)
      .find((l): l is string => !!l);
    text = newest ?? (firstLine(input.lastLog ?? '') || 'Working');
  }
  if (input.queued > 0) text = `${text} · ${input.queued} queued`;
  return { text, live: true, waiting: false };
}

// ── line 2 ──────────────────────────────────────────────────────────────────

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export interface SubSpaceCountsView {
  total: number;
  running: number;
  waiting: number;
}

export function countSubSpaces(
  rows: readonly SubSpaceRow[],
): SubSpaceCountsView {
  const c = { total: rows.length, running: 0, waiting: 0 };
  for (const r of rows) {
    if (r.state === 'running') c.running += 1;
    else if (r.state === 'waiting') c.waiting += 1;
  }
  return c;
}

/** "2 agents · 2 sub-spaces (1 running, 1 waiting)"; `null` with neither. */
export function activityHeadline(
  agents: readonly SubagentView[],
  rows: readonly SubSpaceRow[],
): string | null {
  const parts: string[] = [];
  if (agents.length > 0) parts.push(plural(agents.length, 'agent'));
  const c = countSubSpaces(rows);
  if (c.total > 0) {
    const inside = [
      c.running > 0 && `${c.running} running`,
      c.waiting > 0 && `${c.waiting} waiting`,
    ].filter(Boolean);
    parts.push(
      inside.length
        ? `${plural(c.total, 'sub-space')} (${inside.join(', ')})`
        : plural(c.total, 'sub-space'),
    );
  }
  return parts.length ? parts.join(' · ') : null;
}

/** Something on line 2 is still going. */
export const activityBusy = (
  agents: readonly SubagentView[],
  rows: readonly SubSpaceRow[],
): boolean =>
  agents.some((a) => a.status === 'running') ||
  rows.some((r) => r.state === 'running' || r.state === 'waiting');

// ── the sheet ───────────────────────────────────────────────────────────────

/** A sub-space's word in the sheet, lowercase after its title. */
export const SHEET_SUB_LABEL: Record<SubSpaceState, string> = {
  running: 'running',
  waiting: 'waiting for an answer',
  done: 'done',
  merged: 'merged',
  failed: 'failed',
};

export interface ActivitySheetView {
  /** The plan, while a turn runs with one. */
  progress: SpaceProgress | null;
  /** "This turn" (running) or "Last turn". */
  turnTitle: string;
  agents: SubagentView[];
  subs: SubSpaceRow[];
}

export function activitySheet(input: {
  status: SpaceStatus;
  progress: SpaceProgress | null;
  source: TurnSource | null;
  root: string;
  subSpaces: Readonly<Record<string, MirroredSubSpace>> | undefined;
}): ActivitySheetView {
  const running = input.status === 'running';
  const agents = input.source
    ? subagentsOf(input.source.steps, input.source.running)
    : [];
  return {
    progress: running && input.progress?.steps.length ? input.progress : null,
    turnTitle: input.source?.running ? 'This turn' : 'Last turn',
    agents,
    subs: input.subSpaces ? subSpaceRows(input.root, input.subSpaces) : [],
  };
}

/** The strip has something to show: a running line, or things to list. */
export const showsActivity = (
  line: ActivityLine | null,
  headline: string | null,
): boolean => line !== null || headline !== null;
