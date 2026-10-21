/** When a project page refreshes itself, and when it admits its data is
 *  old. The core's poller refreshes host projects every ~10 minutes in the
 *  background, so a "fetched … ago" only shows once that has fallen behind
 *  (offline, a failed fetch) — not as a permanent timestamp. */
import { observable, runInAction } from 'mobx';
import { refreshProject } from '../../actions';
import type { RootStore } from '../../stores/RootStore';
import { ago } from '../List';

const MINUTE = 60_000;
/** Opening a page older than this refreshes it. */
export const AUTO_REFRESH_AFTER_MS = 5 * MINUTE;
/** Older than this, the header says how old. */
export const STALE_AFTER_MS = 10 * MINUTE;

export function needsAutoRefresh(
  lastFetchedAt: number | null | undefined,
  now: number,
): boolean {
  return lastFetchedAt == null || now - lastFetchedAt > AUTO_REFRESH_AFTER_MS;
}

/** "fetched 12m ago" when stale, otherwise nothing. */
export function staleFetchedLabel(
  lastFetchedAt: number | null | undefined,
  now: number,
): string | null {
  if (lastFetchedAt == null || now - lastFetchedAt <= STALE_AFTER_MS) {
    return null;
  }
  return `fetched ${ago(lastFetchedAt)} ago`;
}

/** Projects with a refresh in flight, from any trigger (page open, ⟳, the
 *  sidebar's context menu): the page's ⟳ spins for all of them. */
export const refreshingProjects = observable.set<string>();

/** `refreshProject`, tracked in `refreshingProjects`; a second call for a
 *  project already refreshing is dropped. */
export async function refreshProjectTracked(
  store: RootStore,
  id: string,
): Promise<void> {
  if (refreshingProjects.has(id)) return;
  runInAction(() => refreshingProjects.add(id));
  try {
    await refreshProject(store, id);
  } finally {
    runInAction(() => refreshingProjects.delete(id));
  }
}
