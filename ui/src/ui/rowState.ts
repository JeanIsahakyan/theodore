/** What a chat row needs to outlive being scrolled out of view, and to change
 *  height without moving what you clicked. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

/** Whether something in a row is open, by its key: a row out of view is gone,
 *  and so is leaving the space. In memory, closed by default. */
const kept = new Map<string, boolean>();

/** `useState` for an open flag, kept per `key`. No key: this mount's only. */
export function useKeptOpen(key: string | null) {
  const [open, setOpen] = useState(() =>
    key == null ? false : (kept.get(key) ?? false),
  );
  const set = useCallback(
    (next: boolean) => {
      if (key != null) kept.set(key, next);
      setOpen(next);
    },
    [key],
  );
  return [open, set] as const;
}

export type Steady = (change: () => void) => void;

export const SteadyContext = createContext<Steady | null>(null);
const unsteady: Steady = (change) => change();

/** For a row's own toggle: `steady(() => setOpen(...))` keeps what you clicked
 *  where it is. Outside a virtual chat it just makes the change. */
export function useSteadyChange(): Steady {
  return useContext(SteadyContext) ?? unsteady;
}

// ── a row asked to show itself ─────────────────────────────────────────────

/** A subagent's row was asked for (the Agents panel or view): the fold it is
 *  in opens, the row brings itself into view. Rows not mounted yet see it
 *  as they mount, for a few seconds. */
export interface Reveal {
  /** The `Agent`/`Task` call id. */
  call: string;
  /** The space and the chat row (`VirtualChat` key) it's in, for a page
   *  that opens on it. */
  space?: string;
  turn?: string | null;
  at: number;
}

const REVEAL_MS = 4000;
let pending: Reveal | null = null;
const revealers = new Set<() => void>();

export function revealCall(r: Omit<Reveal, 'at'>): void {
  pending = { ...r, at: Date.now() };
  for (const f of [...revealers]) f();
}

/** The reveal still waiting for its row, if any. */
export function pendingReveal(): Reveal | null {
  if (pending && Date.now() - pending.at > REVEAL_MS) pending = null;
  return pending;
}

/** The row showed itself: no one else acts on it. */
export function revealDone(call: string): void {
  if (pending?.call === call) pending = null;
}

/** Calls `onReveal` when one of `calls` is asked for, now or while mounted.
 *  `calls` is a key: `\n`-joined ids; `null` listens for nothing. */
export function useReveal(
  calls: string | null,
  onReveal: (call: string) => void,
): void {
  const latest = useRef(onReveal);
  useEffect(() => {
    latest.current = onReveal;
  });
  useEffect(() => {
    if (!calls) return;
    const ids = new Set(calls.split('\n'));
    const check = () => {
      const r = pendingReveal();
      if (r && ids.has(r.call)) latest.current(r.call);
    };
    check();
    revealers.add(check);
    return () => {
      revealers.delete(check);
    };
  }, [calls]);
}
