/**
 * The agent's indicator (`PinceNezIndicator`) where an agent shows up: a chat's
 * running turn, a space or PR in the sidebar and tabs, the review header.
 * What it shows is `indicatorState`; these only read the store for it, each
 * through a `computed` so a surface re-renders when the state changes, not on
 * every step or piece of text.
 */
import { computed } from 'mobx';
import { observer } from 'mobx-react-lite';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { askRunId } from '../actions';
import type { PrId } from '../gen/contract';
import type { RootStore } from '../stores/RootStore';
import { useRootStore } from '../stores/context';
import {
  HeldIndicator,
  indicatorState,
  ONE_SHOT_MS,
  type EndOf,
  type TurnEnd,
} from './agentIndicator';
import { PINCE_NEZ_LABELS, PinceNezIndicator } from './PinceNezIndicator';
import type { PinceNezState } from './PinceNezIndicator';
import { actionablePlan } from './space/spaces';

const NO_END: EndOf = () => null;

/** A state held long enough to read (`HeldIndicator`), re-rendering only when
 *  it changes. */
function useHeld(
  live: PinceNezState | null,
  run: string | null,
  endOf: EndOf,
): PinceNezState | null {
  const [held] = useState(() => new HeldIndicator(live, run));
  useLayoutEffect(() => held.update(live, run, endOf));
  useEffect(() => () => held.stop(), [held]);
  return useSyncExternalStore(held.subscribe, held.get, held.get);
}

// ── a chat's running turn ───────────────────────────────────────────────────

const runState = (store: RootStore, run: string | null): PinceNezState =>
  indicatorState({
    running: true,
    steps: run ? store.ephemeral.runSteps.get(run) : null,
    stalled: run != null && store.ephemeral.stalled.has(run),
  });

/** Runs a live row showed, and when it went away: the reply's `TurnEndMark`
 *  plays only for a turn watched to its end, not an old reply scrolled to. */
const watched = new Map<string, number | null>();
const playedEnds = new Set<string>();

/** A live row's indicator, 20 px beside its timer. Named for a screen reader
 *  only while nothing else shows the agent is at work. */
export const RunIndicator = observer(function RunIndicator({
  run,
}: {
  run: string | null;
}) {
  const store = useRootStore();
  const live = useMemo(
    () => computed(() => runState(store, run)),
    [store, run],
  ).get();
  const silent = useMemo(
    () =>
      computed(
        () =>
          !store.ephemeral.runSteps.get(run ?? '')?.length &&
          !store.ephemeral.agentText.get(run ?? '') &&
          !(run != null && store.ephemeral.stalled.has(run)),
      ),
    [store, run],
  ).get();
  useEffect(() => {
    if (!run) return;
    watched.set(run, null);
    return () => {
      watched.set(run, Date.now());
    };
  }, [run]);
  const shown = useHeld(live, run, NO_END) ?? 'thinking';
  return (
    <PinceNezIndicator
      state={shown}
      size={20}
      decorative={!silent}
      label={PINCE_NEZ_LABELS.thinking}
    />
  );
});

/** The window after a live row goes away in which its reply plays. */
const END_GRACE_MS = 3_000;

const justWatched = (run: string): boolean => {
  if (!watched.has(run)) return false;
  const ended = watched.get(run);
  return ended == null || Date.now() - ended < END_GRACE_MS;
};

/** On a reply that just landed: `done` or `error` once, then gone. Scrolling
 *  away and back (a remounted row) doesn't play it again. */
export function TurnEndMark({
  run,
  end,
}: {
  run?: string | null;
  end: TurnEnd | null;
}) {
  const [shot, setShot] = useState<TurnEnd | null>(() =>
    end && run && justWatched(run) && !playedEnds.has(run) ? end : null,
  );
  useEffect(() => {
    if (!shot || !run) return;
    playedEnds.add(run);
    const timer = setTimeout(() => setShot(null), ONE_SHOT_MS[shot]);
    return () => clearTimeout(timer);
  }, [shot, run]);
  if (!shot) return null;
  return (
    <PinceNezIndicator
      state={shot}
      size={20}
      decorative
      className="turn-end-mark shrink-0"
    />
  );
}

// ── a space, a review ───────────────────────────────────────────────────────

function spaceLive(store: RootStore, id: string): PinceNezState | null {
  const s = store.models.spaces.get(id);
  if (!s) return null;
  if (s.status === 'idle') return actionablePlan(s) ? 'turn' : null;
  if (s.status !== 'running') return null;
  const run = s.run ?? null;
  return indicatorState({
    running: true,
    steps: run ? store.ephemeral.runSteps.get(run) : null,
    waiting: run != null && s.question?.run === run,
    stalled: run != null && store.ephemeral.stalled.has(run),
  });
}

/** A space's indicator: its running turn, a question or plan waiting on you,
 *  and `done` / `error` once when the turn ends (not when you stopped it).
 *  Anything else is `fallback`: the unread dot, the failed mark, the PR tint. */
export const SpaceMark = observer(function SpaceMark({
  spaceId,
  size = 16,
  fallback,
}: {
  spaceId: string;
  size?: number;
  fallback: ReactNode;
}) {
  const store = useRootStore();
  const live = useMemo(
    () => computed(() => spaceLive(store, spaceId)),
    [store, spaceId],
  ).get();
  const space = store.models.spaces.get(spaceId);
  const run = space?.status === 'running' ? (space.run ?? null) : null;
  const shown = useHeld(live, run, (ended) => {
    if (store.models.spaces.get(spaceId)?.status === 'failed') return 'error';
    return store.ephemeral.stoppingRuns.has(ended) ? null : 'done';
  });
  if (!shown) return <>{fallback}</>;
  return <PinceNezIndicator state={shown} size={size} decorative />;
});

const prBusy = (store: RootStore, pr: PrId): boolean =>
  !!store.ephemeral.grouping.get(pr)?.running ||
  store.models.skillRuns.byPr(pr).some((r) => r.status === 'running');

function prRun(store: RootStore, pr: PrId): string | null {
  const asked = store.ephemeral.chatPending.get(pr)?.run;
  if (asked) return asked;
  for (const a of store.ephemeral.lineAsks.values()) {
    if (a.pr === pr && a.status === 'asking' && a.message) {
      return askRunId(a.message);
    }
  }
  return null;
}

function prLive(store: RootStore, pr: PrId): PinceNezState | null {
  const run = prRun(store, pr);
  if (run) {
    return indicatorState({
      running: true,
      steps: store.ephemeral.runSteps.get(run),
      stalled: store.ephemeral.stalled.has(run),
    });
  }
  return prBusy(store, pr) ? indicatorState({ busy: true }) : null;
}

/** A PR tab's indicator while an agent works on that PR: grouping, a skill, a
 *  question in its AI panel. `fallback` otherwise: the tab's PR status icon. */
export const PrMark = observer(function PrMark({
  pr,
  size = 16,
  fallback,
}: {
  pr: PrId;
  size?: number;
  fallback: ReactNode;
}) {
  const store = useRootStore();
  const live = useMemo(
    () => computed(() => prLive(store, pr)),
    [store, pr],
  ).get();
  const shown = useHeld(live, null, NO_END);
  if (!shown) return <>{fallback}</>;
  return <PinceNezIndicator state={shown} size={size} decorative />;
});

/** In the review header while grouping or a skill runs: 20 px beside what it
 *  is. Nothing otherwise. */
export const ReviewAgentStatus = observer(function ReviewAgentStatus({
  pr,
}: {
  pr: PrId;
}) {
  const store = useRootStore();
  const grouping = !!store.ephemeral.grouping.get(pr)?.running;
  if (!grouping && !prBusy(store, pr)) return null;
  return (
    <span className="rv-agent-status flex shrink-0 items-center gap-1.5 text-xs text-muted">
      <PinceNezIndicator
        state={indicatorState({ busy: true })}
        size={20}
        decorative
      />
      {grouping ? 'Grouping…' : 'Running a skill…'}
    </span>
  );
});
