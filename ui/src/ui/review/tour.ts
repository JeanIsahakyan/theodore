/**
 * Pure tour-stepping logic — index arithmetic only, no React/store, so the
 * guided walk through a PR's groups is unit-testable on its own.
 */

/** Where the tour starts: the first group with an unread hunk, or the first
 *  group if everything is already read. */
export function tourStartIndex(groupsAllRead: boolean[]): number {
  const i = groupsAllRead.findIndex((read) => !read);
  return i >= 0 ? i : 0;
}

/** The next tour step, or `null` once the last group has been passed —
 *  callers end the tour on `null`. */
export function tourNextIndex(current: number, total: number): number | null {
  const next = current + 1;
  return next < total ? next : null;
}

/** The previous tour step, or `null` at the first group — Back is disabled
 *  there. */
export function tourPrevIndex(current: number): number | null {
  return current > 0 ? current - 1 : null;
}
