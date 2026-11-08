/** What an opened tool row reads: the call's full input and output, fetched
 *  when the row opens, by run and call id. They aren't part of `TurnStep`, so
 *  bootstrap and every sync frame stay light, and a closed row costs nothing.
 *
 *  ```text
 *  closed            nothing fetched, nothing rendered
 *     │ opened
 *     ▼
 *  loading ─▶ payload  (none: a turn from before these were stored)
 *     ▲          │
 *     └──────────┘ the step moved on (its result, its background task ended)
 *  ```
 */
import { createContext, useContext, useEffect, useState } from 'react';
import { api } from '../core/api';
import type { ToolPayload } from '../gen/contract';
import { useSteadyChange } from './rowState';
import type { ToolStep } from './turnRows';

/** The run a chat's rows came from: a message's, or the one still going. */
export const ToolRunContext = createContext<string | null>(null);

export const useToolRun = () => useContext(ToolRunContext);

interface CacheEntry {
  rev: string;
  payload: ToolPayload | null;
}

/** Recently opened calls: a row scrolled away and back shows at once, at its
 *  full height. In memory, like what a row keeps open. */
const cache = new Map<string, CacheEntry>();
const CACHE_MAX = 32;

function remember(key: string, entry: CacheEntry) {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > CACHE_MAX) {
    cache.delete(cache.keys().next().value!);
  }
}

/** A stored row's open state and fetch key. `null`: no call to ask about. */
export function toolKey(
  run: string | null,
  step: { id?: string | null },
): string | null {
  return run && step.id ? `${run}\u0000${step.id}` : null;
}

/** Changes when the step learns something a fetch would see differently. */
const revOf = (step: ToolStep) =>
  `${step.ok}:${step.summary ?? ''}:${step.background ?? false}`;

export interface ToolPayloadState {
  loading: boolean;
  /** `null`: nothing stored for this call. */
  payload: ToolPayload | null;
  /** The read itself failed: not the same as nothing being stored. */
  failed: boolean;
}

const EMPTY: ToolPayloadState = {
  loading: false,
  payload: null,
  failed: false,
};

/** The call's payload, for as long as its row is open. */
export function useToolPayload(step: ToolStep): ToolPayloadState {
  const run = useToolRun();
  const key = toolKey(run, step);
  const rev = revOf(step);
  const steady = useSteadyChange();
  const [state, setState] = useState<{
    key: string | null;
    value: ToolPayloadState;
  }>(() => {
    if (!key) return { key, value: EMPTY };
    const hit = cache.get(key);
    return {
      key,
      value: hit
        ? { loading: false, payload: hit.payload, failed: false }
        : { loading: true, payload: null, failed: false },
    };
  });

  useEffect(() => {
    if (!key || !run || !step.id) return;
    if (cache.get(key)?.rev === rev) return;
    let live = true;
    void api
      .toolPayload(run, step.id)
      .then((payload) => {
        remember(key, { rev, payload });
        if (!live) return;
        // What lands grows the row: what you were looking at stays put.
        steady(() =>
          setState({
            key,
            value: { loading: false, payload, failed: false },
          }),
        );
      })
      .catch(() => {
        if (!live) return;
        setState({
          key,
          value: { loading: false, payload: null, failed: true },
        });
      });
    return () => {
      live = false;
    };
  }, [key, rev, run, step.id, steady]);

  return state.key === key
    ? state.value
    : { loading: true, payload: null, failed: false };
}

/** For tests: every read starts fresh. */
export function forgetToolPayloads() {
  cache.clear();
}
