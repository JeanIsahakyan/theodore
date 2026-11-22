/**
 * The first connection's state for a screen (`./load.ts`), from the fleet
 * store: `connecting` is timed with `lateConnecting` at
 * `UNREACHABLE_AFTER_MS`.
 */
import { useEffect, useState } from 'react';
import { useFleetState } from '../state/fleet';
import { lateConnecting } from './connection';
import {
  UNREACHABLE_AFTER_MS,
  homeLoadState,
  loadState,
  type HomeLoadState,
  type LoadState,
} from './load';

/** `true` once the fleet has been `connecting` for `ms` in a row. */
export function useLateConnecting(ms: number): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const watch = lateConnecting(setLate, ms);
    watch.update(useFleetState.getState().connection);
    const off = useFleetState.subscribe((s) => watch.update(s.connection));
    return () => {
      off();
      watch.dispose();
    };
  }, [ms]);
  return late;
}

export function useLoadState(): LoadState {
  const connection = useFleetState((s) => s.connection);
  const welcomed = useFleetState((s) => s.welcomed);
  const late = useLateConnecting(UNREACHABLE_AFTER_MS);
  return loadState(connection, welcomed, late);
}

/** Home's: `empty` once the fleet answered without a startable computer. */
export function useHomeLoadState(startable: boolean): HomeLoadState {
  const connection = useFleetState((s) => s.connection);
  const welcomed = useFleetState((s) => s.welcomed);
  const late = useLateConnecting(UNREACHABLE_AFTER_MS);
  return homeLoadState(connection, welcomed, startable, late);
}
