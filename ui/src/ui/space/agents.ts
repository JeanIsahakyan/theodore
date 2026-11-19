/**
 * What a space has set going (docs/spaces.md "Seeing sub-spaces and agents"):
 * the subagents of its current or last turn, its background tasks, and one
 * line for them all. Pure: the strip above the composer only draws these.
 *
 * ```text
 * turn running ──▶ its live steps (runSteps)        subagents, running ones spin
 * turn ended   ──▶ the last reply's stored steps    subagents, done / failed
 *                  a background one still going ──▶ running (its task says so)
 * background tasks ──▶ commands, and subagents not in that turn's list
 *                      (one in it is its row there, with the task's status)
 * ```
 */
import type {
  BackgroundTask,
  ChatMessage,
  Space,
  TurnStep,
} from '../../gen/contract';
import { toolRow } from '../toolSummary';
import { endedLabel } from './backgroundTaskRows';
import { pairTurns } from './chatTurns';
import { splitQueue } from './queue';

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
  /** Its background task, when it runs (or ran) in the background: the
   *  row's status word and Stop are the task's. */
  task: BackgroundTask | null;
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
      task: task ?? null,
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

/** The word a subagent row ends on: its background task's once that ended
 *  (`stopped`, `cut off`, `lost`), else where its call stands. */
export function subagentStatusLabel(
  a: Pick<SubagentView, 'status' | 'task'>,
): string {
  if (a.task && a.task.status !== 'running' && a.status !== 'failed') {
    return endedLabel(a.task.status);
  }
  return SUBAGENT_STATUS[a.status];
}

/** A subagent row's word reads as trouble. */
export const subagentTrouble = (a: Pick<SubagentView, 'status' | 'task'>) =>
  a.status === 'failed' || a.task?.status === 'lost';

/** How long it ran (or has run, at `now`); `null` when not known. */
export function subagentElapsed(
  a: Pick<SubagentView, 'startedAt' | 'endedAt' | 'status'>,
  now: number,
): number | null {
  if (a.startedAt == null) return null;
  const end = a.endedAt ?? (subagentLive(a) ? now : null);
  return end == null ? null : Math.max(0, end - a.startedAt);
}

/** The turn the strip reads: the running one's live steps, else the last
 *  reply that has any. `turn` is the chat row it's in (a key
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

/** The strip's "Background" rows: the tasks shown, less the subagents
 *  already listed as the turn's (each thing is one row). */
export function backgroundRows(
  shown: readonly BackgroundTask[],
  agents: readonly Pick<SubagentView, 'call'>[],
): BackgroundTask[] {
  const listed = new Set(agents.map((a) => a.call));
  return shown.filter(
    (t) => t.kind !== 'subagent' || !t.call || !listed.has(t.call),
  );
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** The strip's one line, from its rows:
 *  "2 agents running · 3 sub-spaces, 1 running · 1 command running". A
 *  background subagent counts as an agent, a background command as a
 *  command. */
export function stripHeadline(
  agents: readonly Pick<SubagentView, 'status'>[],
  background: readonly Pick<BackgroundTask, 'kind' | 'status'>[],
  subs: readonly Pick<Space, 'status'>[],
): string {
  const parts: string[] = [];
  const bgAgents = background.filter((t) => t.kind === 'subagent');
  const total = agents.length + bgAgents.length;
  const live =
    agents.filter(subagentLive).length +
    bgAgents.filter((t) => t.status === 'running').length;
  if (live > 0) parts.push(`${plural(live, 'agent')} running`);
  else if (total > 0) parts.push(plural(total, 'agent'));
  if (subs.length > 0) {
    const running = subs.filter((s) => s.status === 'running').length;
    const n = plural(subs.length, 'sub-space');
    parts.push(running > 0 ? `${n}, ${running} running` : n);
  }
  const commands = background.filter((t) => t.kind !== 'subagent');
  const count = (status: BackgroundTask['status']) =>
    commands.filter((t) => t.status === status).length;
  const running = count('running');
  const lost = count('lost');
  const cut = count('cut');
  if (running > 0) parts.push(`${plural(running, 'command')} running`);
  else if (lost > 0) parts.push(`${plural(lost, 'command')} lost`);
  else if (cut > 0) parts.push(`${plural(cut, 'command')} cut off`);
  else if (commands.length > 0) {
    parts.push(`${plural(commands.length, 'command')} ended`);
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
