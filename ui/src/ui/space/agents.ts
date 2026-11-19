/**
 * What a space has set going (docs/spaces.md "Seeing sub-spaces and agents"):
 * the subagents of its current or last turn, and what is running right now
 * across spaces for the Agents view. Pure: the panels only draw these.
 *
 * ```text
 * turn running ──▶ its live steps (runSteps)        subagents, running ones spin
 * turn ended   ──▶ the last reply's stored steps    subagents, done / failed
 *                  a background one still going ──▶ running (its task says so)
 * ```
 */
import type {
  BackgroundTask,
  ChatMessage,
  Space,
  TurnStep,
} from '../../gen/contract';
import { toolRow } from '../toolSummary';
import { pairTurns } from './chatTurns';
import { splitQueue } from './queue';
import { asking, nestSpaces, type SpaceNode } from './subspaces';

export type SubagentStatus = 'running' | 'background' | 'done' | 'failed';

/** One subagent row. */
export interface SubagentView {
  /** Its `Agent`/`Task` call id: what the timeline row is found by. */
  call: string;
  description: string;
  status: SubagentStatus;
  /** When it started and ended, when known (this session's live steps, or
   *  its background task). */
  startedAt: number | null;
  endedAt: number | null;
}

/** When a call started and ended, as this window saw it. */
export type StepTimes = (call: string) => {
  start: number;
  end: number | null;
} | null;

const NO_TIMES: StepTimes = () => null;

/** The top-level subagents in `steps`, in the order they started. A
 *  subagent's own subagents stay in its timeline row. */
export function subagentsOf(
  steps: readonly TurnStep[],
  opts: {
    /** The turn is still going: a call with no result runs. */
    running: boolean;
    tasks?: readonly BackgroundTask[];
    times?: StepTimes;
  },
): SubagentView[] {
  const times = opts.times ?? NO_TIMES;
  const taskOf = new Map(
    (opts.tasks ?? []).flatMap((t) => (t.call ? [[t.call, t] as const] : [])),
  );
  const out: SubagentView[] = [];
  for (const s of steps) {
    if (s.kind !== 'tool' || s.parent || !s.id) continue;
    if (toolRow(s.name).kind !== 'agent') continue;
    const task = taskOf.get(s.id);
    const seen = times(s.id);
    const waiting = !!s.background && !s.summary;
    let status: SubagentStatus;
    if (task?.status === 'running') status = 'background';
    else if (opts.running && (s.ok == null || waiting)) {
      status = waiting ? 'background' : 'running';
    } else if (s.ok === false || task?.status === 'failed') status = 'failed';
    else status = 'done';
    const live = status === 'running' || status === 'background';
    out.push({
      call: s.id,
      description: s.detail?.trim() || 'Subagent',
      status,
      startedAt: task?.started_at ?? seen?.start ?? null,
      endedAt: live ? null : (task?.ended_at ?? seen?.end ?? null),
    });
  }
  return out;
}

export const subagentLive = (a: Pick<SubagentView, 'status'>) =>
  a.status === 'running' || a.status === 'background';

/** The word beside a subagent. */
export const SUBAGENT_STATUS: Record<SubagentStatus, string> = {
  running: 'running',
  background: 'running in background',
  done: 'done',
  failed: 'failed',
};

/** How long it ran (or has run, at `now`); `null` when not known. */
export function subagentElapsed(
  a: Pick<SubagentView, 'startedAt' | 'endedAt' | 'status'>,
  now: number,
): number | null {
  if (a.startedAt == null) return null;
  const end = a.endedAt ?? (subagentLive(a) ? now : null);
  return end == null ? null : Math.max(0, end - a.startedAt);
}

/** The turn the Agents panel reads: the running one's live steps, else the
 *  last reply that has any. `turn` is the chat row it's in (a key
 *  `VirtualChat.scrollToKey` takes). */
export interface TurnSource {
  run: string | null;
  turn: string | null;
  steps: readonly TurnStep[];
  running: boolean;
}

export function turnSource(
  space: Pick<Space, 'status' | 'run'>,
  messages: readonly ChatMessage[],
  liveSteps: (run: string) => readonly TurnStep[] | undefined,
  keyOf: (id: string) => string = (id) => id,
): TurnSource | null {
  const turns = pairTurns(splitQueue(messages).sent, keyOf);
  const run = space.status === 'running' ? (space.run ?? null) : null;
  if (run) {
    const steps = liveSteps(run);
    // Its reply is stored already (a check still runs): those steps.
    const stored = findReply(turns, (m) => m.run === run);
    if (stored) {
      return {
        run,
        turn: stored.turn,
        steps: stored.reply.activity ?? [],
        running: true,
      };
    }
    return {
      run,
      turn: turns.at(-1)?.key ?? 'live',
      steps: steps ?? [],
      running: true,
    };
  }
  const last = findReply(
    turns,
    (m) => m.author.kind === 'agent' && (m.activity?.length ?? 0) > 0,
  );
  if (!last) return null;
  return {
    run: last.reply.run ?? null,
    turn: last.turn,
    steps: last.reply.activity ?? [],
    running: false,
  };
}

/** The newest message matching `pick`, and the key of its turn's row. */
function findReply(
  turns: ReturnType<typeof pairTurns>,
  pick: (m: ChatMessage) => boolean,
): { turn: string; reply: ChatMessage } | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = turns[i]!;
    for (let j = t.messages.length - 1; j >= 0; j -= 1) {
      const m = t.messages[j]!;
      if (pick(m)) return { turn: t.key, reply: m };
    }
  }
  return null;
}

/** The panel's one line: "2 agents running · 3 sub-spaces, 1 running". */
export function agentsHeadline(
  agents: readonly Pick<SubagentView, 'status'>[],
  subs: readonly Pick<Space, 'status'>[],
): string {
  const parts: string[] = [];
  const live = agents.filter(subagentLive).length;
  if (live > 0) parts.push(`${live} agent${live === 1 ? '' : 's'} running`);
  else if (agents.length > 0) {
    parts.push(`${agents.length} agent${agents.length === 1 ? '' : 's'}`);
  }
  if (subs.length > 0) {
    const running = subs.filter((s) => s.status === 'running').length;
    const n = `${subs.length} sub-space${subs.length === 1 ? '' : 's'}`;
    parts.push(running > 0 ? `${n}, ${running} running` : n);
  }
  return parts.join(' · ');
}

/** A space doing something right now: a turn, or a task in the background. */
export function spaceBusy(
  s: Pick<Space, 'status' | 'background_tasks'>,
): boolean {
  return (
    s.status === 'running' ||
    (s.status !== 'archived' &&
      (s.background_tasks ?? []).some((t) => t.status === 'running'))
  );
}

/** What the Agents view lists: each tree of spaces with something running
 *  in it (or an agent waiting on you), the busiest first. Archived spaces
 *  aside. */
export function activeTrees(all: readonly Space[]): SpaceNode[] {
  const live = all
    .filter((s) => s.status !== 'archived')
    .sort((a, b) => b.updated_at - a.updated_at);
  const active = (n: SpaceNode): boolean =>
    spaceBusy(n.space) || asking(n.space) || n.children.some(active);
  return nestSpaces(live).filter(active);
}

/** Spaces with a turn running, everywhere: the sidebar's count. */
export const runningSpaces = (all: readonly Space[]): number =>
  all.filter((s) => s.status === 'running').length;
