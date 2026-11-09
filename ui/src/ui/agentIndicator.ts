/**
 * What the agent's indicator (`PinceNezIndicator`) shows, and for how long.
 * Every surface asks `indicatorState`; `AgentMark` holds what it returns so a
 * burst of tool calls doesn't flash.
 *
 * ```text
 * a turn runs      steps ──▶ thinking | reading | writing | loading | turn
 *                   │ held DWELL_MS at least, so calls ms apart don't flicker
 * the turn ends   ──▶ done | error once, ONE_SHOT_MS, then the surface's own
 *                    mark (unread dot, failed mark, PR glyph)
 * ```
 */
import type { TurnStep } from '../gen/contract';
import type { PinceNezState } from './PinceNezIndicator';
import { stepWaitsForYou, type ToolStep } from './turnRows';
import { toolRow, type ToolKind } from './toolSummary';

export type TurnEnd = 'done' | 'error';

export interface IndicatorInput {
  /** The turn just ended: how. Wins over everything else. */
  ended?: TurnEnd | null;
  /** The agent waits for you: a question, a plan to approve. */
  waiting?: boolean;
  /** No output in a while: nothing to animate. */
  stalled?: boolean;
  /** A turn or run is in flight; `steps` say what it's on. */
  running?: boolean;
  /** The run's steps so far, newest last. */
  steps?: readonly TurnStep[] | null;
  /** Work with no steps of its own: grouping, a skill, a sync. */
  busy?: boolean;
}

const KIND_STATE: Record<ToolKind, PinceNezState> = {
  read: 'reading',
  search: 'reading',
  edit: 'writing',
  run: 'loading',
  agent: 'loading',
  mcp: 'loading',
  other: 'loading',
};

/** A running call: a background one has already handed the agent back. */
const callRunning = (s: TurnStep): s is ToolStep =>
  s.kind === 'tool' && s.ok == null && !s.background;

/** What a run's latest step says it is doing. A call that just ended means
 *  the agent is deciding what's next: thinking. */
function activityOf(steps: readonly TurnStep[]): PinceNezState {
  let at = steps.length - 1;
  while (at >= 0 && steps[at]!.kind === 'text' && !stepText(steps[at]!)) {
    at -= 1;
  }
  const latest = steps[at];
  if (!latest || latest.kind === 'thinking') return 'thinking';
  if (latest.kind === 'text') return 'writing';
  // Parallel calls: the newest one still going, whichever came last.
  for (let i = at; i >= 0; i -= 1) {
    const step = steps[i]!;
    if (!callRunning(step)) continue;
    if (stepWaitsForYou(step)) return 'turn';
    return KIND_STATE[toolRow(step.name).kind];
  }
  return 'thinking';
}

const stepText = (s: TurnStep) => (s.kind === 'text' ? s.text.trim() : '');

/** The state for one surface, from what it knows of the agent's work. */
export function indicatorState(input: IndicatorInput): PinceNezState {
  if (input.ended) return input.ended;
  if (input.waiting) return 'turn';
  if (input.stalled) return 'idle';
  if (input.running) return activityOf(input.steps ?? []);
  if (input.busy) return 'loading';
  return 'idle';
}

// ── how long a state stays ───────────────────────────────────────────────────

/** The shortest a working state shows. */
export const DWELL_MS = 300;

/** How long the one-shots play (the CSS's durations). */
export const ONE_SHOT_MS: Record<TurnEnd, number> = {
  done: 2400,
  error: 1600,
};

export const isOneShot = (s: PinceNezState | null): s is 'done' | 'error' =>
  s === 'done' || s === 'error';

export interface Hold {
  shown: PinceNezState | null;
  since: number;
}

export interface HoldStep {
  hold: Hold;
  /** Offer `target` again after this long. `null`: nothing to wait for. */
  wakeIn: number | null;
}

/** What to show given `target` and how long the current state has shown: a
 *  one-shot always shows at once, anything else waits out the dwell. */
export function nextHold(
  hold: Hold,
  target: PinceNezState | null,
  now: number,
): HoldStep {
  if (target === hold.shown) return { hold, wakeIn: null };
  const shown = now - hold.since;
  if (isOneShot(target) || shown >= DWELL_MS) {
    return { hold: { shown: target, since: now }, wakeIn: null };
  }
  return { hold, wakeIn: DWELL_MS - shown };
}

/** How a turn that was running ended, once it has: `null` means no one-shot
 *  (it was stopped). */
export type EndOf = (run: string) => TurnEnd | null;

/** One surface's indicator, over time: what `indicatorState` says, dwelled,
 *  with the one-shot once a run stops. A subscribable value so a surface
 *  re-renders on a state change and nothing else. */
export class HeldIndicator {
  private hold: Hold;
  private run: string | null;
  private live: PinceNezState | null;
  private shot: TurnEnd | null = null;
  private shotTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    live: PinceNezState | null,
    run: string | null,
    private readonly now: () => number = Date.now,
  ) {
    this.live = live;
    this.run = run;
    this.hold = { shown: live, since: -Infinity };
  }

  /** The state to draw, or `null` for the surface's own mark. */
  readonly get = (): PinceNezState | null => this.hold.shown;

  readonly subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** `run`: the turn in flight, or `null`. A run that goes away with no next
   *  one ended: `endOf` says how. A next one starting isn't an end. */
  update(live: PinceNezState | null, run: string | null, endOf: EndOf): void {
    if (this.run && !run) this.startShot(endOf(this.run));
    else if (run) this.startShot(null);
    this.run = run;
    this.live = live;
    this.refresh();
  }

  stop(): void {
    this.clear('shot');
    this.clear('wake');
  }

  private startShot(end: TurnEnd | null): void {
    this.clear('shot');
    this.shot = end;
    if (!end) return;
    this.shotTimer = setTimeout(() => {
      this.shot = null;
      this.shotTimer = null;
      this.refresh();
    }, ONE_SHOT_MS[end]);
  }

  private refresh(): void {
    this.clear('wake');
    const step = nextHold(this.hold, this.live ?? this.shot, this.now());
    const changed = step.hold !== this.hold;
    this.hold = step.hold;
    if (step.wakeIn != null) {
      this.wakeTimer = setTimeout(() => this.refresh(), step.wakeIn);
    }
    if (changed) for (const fn of this.listeners) fn();
  }

  private clear(which: 'shot' | 'wake'): void {
    const timer = which === 'shot' ? this.shotTimer : this.wakeTimer;
    if (timer != null) clearTimeout(timer);
    if (which === 'shot') this.shotTimer = null;
    else this.wakeTimer = null;
  }
}
