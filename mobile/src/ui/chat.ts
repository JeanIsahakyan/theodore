/**
 * A mirrored space's chat as the screen draws it, the desktop's rules
 * (`ui/src/ui/space/SpaceLog.tsx`, `chatTurns.ts`, `spaces.ts`) without React.
 *
 * ```text
 * turn   you ─ reply (activity, markdown, plan + Approve / Revise)
 * turn   …
 * turn   you ─ live: the run's steps until its reply lands
 * tail   queued messages, the question
 * ```
 */
import type { FleetMode } from '../gen/fleet';
import type {
  ChatMessage,
  Space,
  SpaceProgress,
  SpaceTurn,
  TurnStep,
} from '../fleet/contract';
import {
  liveSteps,
  newestStepRun,
  sortMessages,
  type SpaceMirror,
} from '../fleet/mirror';
import { uiQuestions } from '../fleet/rules';
import type { QuestionView, SpaceView } from '../fleet/types';
import { MODE_ORDER, modesUpTo } from './logic';

/** What the transcript shows for an approval, as the desktop sends it. */
export const APPROVED_TEXT = 'Plan approved, implement it.';

export interface ChatTurn {
  key: string;
  messages: ChatMessage[];
}

/** Each of your messages with the replies under it; a reply with nothing
 *  before it starts its own turn. */
export function pairTurns(sent: readonly ChatMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const m of sent) {
    const last = turns.at(-1);
    if (m.author.kind === 'me' || !last)
      turns.push({ key: m.id, messages: [m] });
    else last.messages.push(m);
  }
  return turns;
}

/** Reply id → its plan, for turns not undone. */
export function plansByReply(
  log: readonly Pick<SpaceTurn, 'reply' | 'plan' | 'undone'>[] | undefined,
): Map<string, string> {
  return new Map(
    (log ?? [])
      .filter((t) => !t.undone && t.plan)
      .map((t) => [t.reply, t.plan!]),
  );
}

/** The reply whose plan Approve / Revise act on: the last turn's, while the
 *  space can take a turn. */
export function actionablePlan(
  s: Pick<Space, 'status' | 'turn_log'>,
): string | null {
  if (s.status === 'running' || s.status === 'archived') return null;
  const log = (s.turn_log ?? []).filter((t) => !t.undone);
  const last = log.at(-1);
  return last?.plan ? last.reply : null;
}

/** Messages of turns that were undone. */
export function undoneMessages(s: Pick<Space, 'turn_log'>): Set<string> {
  return new Set(
    (s.turn_log ?? [])
      .filter((t) => t.undone)
      .flatMap((t) => [t.message, t.reply, ...(t.steered ?? [])]),
  );
}

/** What an approved plan is implemented in: the space's last Edit or Run. */
export const buildMode = (s: Pick<Space, 'build_mode'>): FleetMode =>
  s.build_mode === 'run' ? 'run' : 'edit';

/** Replies are named only when more than one agent wrote them. */
export function mixedAgents(messages: readonly ChatMessage[]): boolean {
  const seen = new Set<string>();
  for (const m of messages)
    if (m.author.kind === 'agent' && m.author.agent) seen.add(m.author.agent);
  return seen.size > 1;
}

export interface LiveTurn {
  run: string | null;
  steps: TurnStep[];
  /** When the turn started: your message's time. */
  since: number | null;
}

export interface ChatView {
  turns: ChatTurn[];
  queued: ChatMessage[];
  /** The running turn, until its reply lands; on the last turn. */
  live: LiveTurn | null;
  question: QuestionView | null;
  /** The reply Approve / Revise sit under. */
  planHere: string | null;
  plans: Set<string>;
  undone: Set<string>;
  tagged: boolean;
  progress: SpaceProgress | null;
  /** The space's error, while it's failed. */
  error: string | null;
}

export function chatView(mirror: SpaceMirror, view: SpaceView): ChatView {
  const row = mirror.space;
  const all = sortMessages(Object.values(mirror.messages));
  const queued = all
    .filter((m) => m.queued)
    .sort((a, b) => (a.queued?.seq ?? 0) - (b.queued?.seq ?? 0));
  const sent = all.filter((m) => !m.queued);
  const turns = pairTurns(sent);
  const running = row
    ? row.status === 'running'
    : view.status === 'running' || view.status === 'waiting';
  const run = running ? (row?.run ?? newestStepRun(mirror)) : null;
  const replied =
    run != null && sent.some((m) => m.author.kind === 'agent' && m.run === run);
  const live: LiveTurn | null =
    running && !replied
      ? {
          run,
          steps: liveSteps(mirror, run),
          since: turns.at(-1)?.messages[0]?.at ?? null,
        }
      : null;
  const q = row?.question;
  const question: QuestionView | null = q
    ? {
        askId: q.id,
        space: view.space,
        from: view.question?.from ?? view.hostName,
        questions: uiQuestions(q.questions),
      }
    : null;
  const progress =
    row?.status === 'running' && row.progress?.steps.length
      ? row.progress
      : null;
  return {
    turns,
    queued,
    live,
    question,
    planHere: row ? actionablePlan(row) : null,
    plans: new Set(plansByReply(row?.turn_log).keys()),
    undone: row ? undoneMessages(row) : new Set(),
    tagged: mixedAgents(sent),
    progress,
    error: row?.status === 'failed' && row.error ? row.error : null,
  };
}

/** The modes the composer offers: up to the host's cap, all when it isn't
 *  listed (the host still enforces its own). */
export const composerModes = (max: FleetMode | null): FleetMode[] =>
  max ? modesUpTo(max) : [...MODE_ORDER];

/** A send's mode: only when it isn't the space's own. */
export const sendMode = (
  picked: FleetMode,
  own: FleetMode,
): FleetMode | null => (picked === own ? null : picked);

/** "Started by a finished background task: …". */
export function fromTasksLabel(tasks: readonly string[]): string {
  if (tasks.length > 1)
    return `Started by ${tasks.length} finished background tasks`;
  return tasks[0]
    ? `Started by a finished background task: ${tasks[0]}`
    : 'Started by a finished background task';
}

/** The failure text of a run you stopped. */
export const STOPPED = 'stopped';

/** `3:37 PM`. */
export const clock = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** `2 of 5 done · note`. */
export function progressLine(p: SpaceProgress): string {
  const done = p.steps.filter((s) => s.state === 'done').length;
  return `${done} of ${p.steps.length} done${p.note ? ` · ${p.note}` : ''}`;
}
