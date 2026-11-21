/**
 * What you did before the host answered (zustand), kept out of the screens
 * so a bubble survives leaving and reopening a space, and a start survives
 * the route change from its pending id to the real space. The rules are
 * `src/ui/pending.ts`; docs/mobile.md "Optimistic sends".
 *
 * ```text
 * sends[space]     your bubbles the host hasn't shown yet (sending, queued,
 *                  sent, failed), oldest first; a sub-space's under its local id
 * starts[id]       a space being started from Home, by its pending route id
 * answers[askId]   an answer on its way: the card shows "Answered: …"
 * homeRestore      a refused start's goal and error, for Home to take back
 * ```
 */
import { create } from 'zustand';
import type { SendResult } from '../fleet/types';
import {
  PENDING_PREFIX,
  failSend,
  newSend,
  retrySend,
  settleSend,
  startLanded,
  startRefused,
  type NewSend,
  type PendingAnswer,
  type PendingSend,
  type PendingStart,
} from '../ui/pending';

export interface PendingState {
  sends: Record<string, PendingSend[]>;
  starts: Record<string, PendingStart>;
  answers: Record<string, PendingAnswer>;
  /** A refused start: Home puts the goal back and shows why. */
  homeRestore: { goal: string; error: string } | null;
}

const initial: PendingState = {
  sends: {},
  starts: {},
  answers: {},
  homeRestore: null,
};

export const usePending = create<PendingState>(() => initial);

/** Back to nothing pending (tests, sign-out). */
export function resetPending(): void {
  usePending.setState(initial, true);
}

const EMPTY: PendingSend[] = [];
/** The pending sends of `space` (a stable empty list when none). */
export const selectSends =
  (space: string) =>
  (s: PendingState): PendingSend[] =>
    s.sends[space] ?? EMPTY;

let counter = 0;
/** A local key, unique in this app run. */
export const nextKey = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}_${(counter += 1)}`;

const updateSend = (
  space: string,
  key: string,
  f: (p: PendingSend) => PendingSend,
) =>
  usePending.setState((s) => {
    const list = s.sends[space];
    if (!list?.some((p) => p.key === key)) return {};
    return {
      sends: {
        ...s.sends,
        [space]: list.map((p) => (p.key === key ? f(p) : p)),
      },
    };
  });

// ── sends ──────────────────────────────────────────────────────────────────

/** A message sent: shown at once as "Sending…". Returns its key. */
export function addSend(input: Omit<NewSend, 'key'>): string {
  const key = nextKey('send');
  const p = newSend({ ...input, key });
  usePending.setState((s) => ({
    sends: { ...s.sends, [p.space]: [...(s.sends[p.space] ?? []), p] },
  }));
  return key;
}

/** The host's word on it. */
export function sendSettled(space: string, key: string, r: SendResult): void {
  updateSend(space, key, (p) => settleSend(p, r));
}

/** Refused, or no answer in time. */
export function sendFailed(space: string, key: string, error: string): void {
  updateSend(space, key, (p) => failSend(p, error));
}

/** Retry: sending again; the screen sends it. Returns the send, or `null`
 *  when it is gone. */
export function sendRetried(space: string, key: string): PendingSend | null {
  updateSend(space, key, (p) => retrySend(p, Date.now()));
  return usePending.getState().sends[space]?.find((p) => p.key === key) ?? null;
}

/** Gone: its row arrived, or Edit took the text back. */
export function dropSend(space: string, key: string): void {
  usePending.setState((s) => {
    const list = s.sends[space];
    if (!list?.some((p) => p.key === key)) return {};
    const kept = list.filter((p) => p.key !== key);
    const sends = { ...s.sends };
    if (kept.length) sends[space] = kept;
    else delete sends[space];
    return { sends };
  });
}

/** Rows arrived that stand for these: dropped together (one store update). */
export function dropSends(space: string, keys: readonly string[]): void {
  if (!keys.length) return;
  const gone = new Set(keys);
  usePending.setState((s) => {
    const list = s.sends[space];
    if (!list?.some((p) => gone.has(p.key))) return {};
    const kept = list.filter((p) => !gone.has(p.key));
    const sends = { ...s.sends };
    if (kept.length) sends[space] = kept;
    else delete sends[space];
    return { sends };
  });
}

// ── starts ─────────────────────────────────────────────────────────────────

/** A space being started: returns its pending route id. Settled starts
 *  (landed, failed) are forgotten then. */
export function addStart(
  input: Omit<PendingStart, 'id' | 'state' | 'space' | 'error' | 'at'>,
): string {
  const p: PendingStart = {
    ...input,
    id: nextKey(PENDING_PREFIX.slice(0, -1)),
    at: Date.now(),
    state: 'starting',
    space: null,
    error: null,
  };
  usePending.setState((s) => {
    const starts: Record<string, PendingStart> = {};
    for (const [id, x] of Object.entries(s.starts))
      if (x.state === 'starting' && x.space === null) starts[id] = x;
    starts[p.id] = p;
    return { starts };
  });
  return p.id;
}

/** The host named the space (or the wait ended with it still starting). */
export function startSettled(id: string, space: string): void {
  usePending.setState((s) => {
    const p = s.starts[id];
    return p ? { starts: { ...s.starts, [id]: startLanded(p, space) } } : {};
  });
}

export function startFailed(id: string, error: string): void {
  usePending.setState((s) => {
    const p = s.starts[id];
    return p ? { starts: { ...s.starts, [id]: startRefused(p, error) } } : {};
  });
}

/** The failed start's goal goes back to Home, with the error. */
export function restoreHome(goal: string, error: string): void {
  usePending.setState({ homeRestore: { goal, error } });
}

/** Home took the goal back. */
export function takeHomeRestore(): { goal: string; error: string } | null {
  const r = usePending.getState().homeRestore;
  if (r) usePending.setState({ homeRestore: null });
  return r;
}

// ── answers ────────────────────────────────────────────────────────────────

/** An answer kept this long once given: the card stays collapsed until
 *  the host's row drops the question; a stale one is forgotten. */
export const ANSWER_KEPT_MS = 60 * 60_000;

/** An answer on its way: the card collapses to `label`. */
export function addAnswer(askId: string, space: string, label: string): void {
  const now = Date.now();
  usePending.setState((s) => {
    const answers: Record<string, PendingAnswer> = {};
    for (const [id, a] of Object.entries(s.answers))
      if (now - a.at < ANSWER_KEPT_MS) answers[id] = a;
    answers[askId] = { askId, space, label, at: now };
    return { answers };
  });
}

export function dropAnswer(askId: string): void {
  usePending.setState((s) => {
    if (!(askId in s.answers)) return {};
    const answers = { ...s.answers };
    delete answers[askId];
    return { answers };
  });
}
