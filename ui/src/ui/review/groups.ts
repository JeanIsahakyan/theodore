/**
 * Pure helpers for group ordering and the hidden/mechanical-group collapse —
 * no React, no store, easy to unit test. `hidden` groups (lockfiles,
 * generated code — see `GroupKind` in the contract) are always listed, but
 * collapsed in the diff by default and skipped by `N`/`P` navigation; the
 * user can still open one with "show anyway".
 */
import type { Group, HunkId } from '../../gen/contract';

/** Groups whose hunks are part of this revision, in reading order. Includes
 *  hidden groups — `GroupsPane` still lists them (collapsed). */
export function groupsInRevision(
  groups: Group[],
  hunkIds: Set<HunkId>,
): Group[] {
  return groups.filter((g) => g.hunks.some((h) => hunkIds.has(h)));
}

/** The subset `N`/`P` navigation (and the groups-pane progress line) step
 *  through — mechanical/hidden groups are nothing to review, so they're
 *  skipped unless opened by hand. */
export function reviewableGroups(groups: Group[]): Group[] {
  return groups.filter((g) => g.kind !== 'hidden');
}

/** The next reviewable group after `currentId`, skipping any hidden ones in
 *  between — used by the diff pane's "Next: …" button. `null` past the end. */
export function nextReviewableGroup(
  groups: Group[],
  currentId: string | null,
): Group | null {
  const i = groups.findIndex((g) => g.id === currentId);
  for (let j = i + 1; j < groups.length; j++) {
    if (groups[j]!.kind !== 'hidden') return groups[j]!;
  }
  return null;
}

/** The previous reviewable group before `currentId`, mirroring
 *  `nextReviewableGroup`. */
export function prevReviewableGroup(
  groups: Group[],
  currentId: string | null,
): Group | null {
  const i = groups.findIndex((g) => g.id === currentId);
  for (let j = i - 1; j >= 0; j--) {
    if (groups[j]!.kind !== 'hidden') return groups[j]!;
  }
  return null;
}

/** The next reviewable group after `currentId` that still has an unread
 *  hunk — what the `R` shortcut steps to once the current group is marked
 *  read. Unlike `nextReviewableGroup`, a fully-read group is skipped too. */
export function nextUnreadGroup(
  groups: Group[],
  currentId: string | null,
  readHunks: ReadonlySet<HunkId>,
): Group | null {
  const i = groups.findIndex((g) => g.id === currentId);
  for (let j = i + 1; j < groups.length; j++) {
    const g = groups[j]!;
    if (g.kind === 'hidden') continue;
    if (g.hunks.some((h) => !readHunks.has(h))) return g;
  }
  return null;
}

/** "3 of 5 groups read" for the groups pane's always-visible progress line —
 *  counts reviewable (non-hidden) groups only, each "read" once every one of
 *  its hunks is (the same read-state the group checkmarks use). */
export function groupsProgress(
  groups: Group[],
  readHunks: ReadonlySet<HunkId>,
): { read: number; total: number; label: string } {
  const reviewable = reviewableGroups(groups);
  const total = reviewable.length;
  const read = reviewable.filter((g) =>
    g.hunks.every((h) => readHunks.has(h)),
  ).length;
  const label =
    total > 0 && read === total
      ? 'All groups read'
      : `${read} of ${total} group${total === 1 ? '' : 's'} read`;
  return { read, total, label };
}
