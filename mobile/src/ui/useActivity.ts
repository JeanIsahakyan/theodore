/**
 * What a space has going, read from the store for the strip above its
 * composer and the activity sheet (`activity.ts` has the rules): the
 * running (or last) turn's subagents, the plan, the sub-spaces.
 */
import { useEffect, useMemo, useState } from 'react';
import { mirrored, sortMessages } from '../fleet/mirror';
import { useFleetState } from '../state/fleet';
import {
  activitySheet,
  trackTimes,
  turnSource,
  type ActivitySheetView,
  type AgentTimes,
} from './activity';
import { chatView } from './chat';

const EMPTY: ActivitySheetView = {
  progress: null,
  turnTitle: 'Last turn',
  agents: [],
  subs: [],
};

/** The sheet's view of `space`; empty for a space not here. */
export function useActivityView(space: string): ActivitySheetView {
  const view = useFleetState((s) => s.spaces.find((x) => x.space === space));
  const mirror = useFleetState((s) => s.mirrors[space]);
  return useMemo(() => {
    if (!view) return EMPTY;
    const chat = mirror && mirrored(mirror) ? chatView(mirror, view) : null;
    const messages = mirror ? sortMessages(Object.values(mirror.messages)) : [];
    return activitySheet({
      status: view.status,
      progress: chat?.progress ?? null,
      source: chat ? turnSource(chat.live, messages) : null,
      root: space,
      subSpaces: mirror?.subSpaces,
    });
  }, [view, mirror, space]);
}

/** When each subagent was first seen and settled here, kept per space
 *  while the app lives (a sheet opened later still reads them). */
const times = new Map<string, AgentTimes>();

/** `now` ticking once a second while `active`, else still. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** The subagents' times for `space`, brought up to date as they change
 *  (pure given the kept times: the same agents at the same `now` read the
 *  same). */
export function useAgentTimes(
  space: string,
  view: ActivitySheetView,
  now: number,
): AgentTimes {
  return useMemo(() => {
    const prev = times.get(space) ?? {};
    const next = trackTimes(prev, view.agents, now);
    if (next !== prev) times.set(space, next);
    return next;
  }, [space, view.agents, now]);
}
