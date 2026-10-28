/**
 * Pure helpers for the keyboard-focused hunk: which hunks are in scope for
 * the current group/file selection, and where focus moves on J/K. No React,
 * no store — mirrors exactly what `DiffPane` renders so J/K lands on what's
 * on screen.
 */
import type { Group, Hunk, HunkId, Revision } from '../../gen/contract';
import type { ReviewMode } from '../GroupsPane';
import { groupDiff } from './groups';

/** Every hunk shown for the current `mode`, in file → hunk order — a
 *  group's files in `groupDiff`'s order, as `DiffPane` lays them out. */
export function hunksInScope(
  rev: Pick<Revision, 'files'>,
  mode: ReviewMode,
  group: Pick<Group, 'hunks' | 'outliers'> | null,
): Hunk[] {
  if (mode.mode === 'files') {
    return rev.files.find((f) => f.path === mode.file)?.hunks ?? [];
  }
  if (group) {
    return groupDiff(rev.files, group.hunks, group.outliers).flatMap(
      (f) => f.hunks,
    );
  }
  return rev.files.flatMap((f) => f.hunks);
}

/** The hunk id focus moves to on J (`delta=1`) / K (`delta=-1`); clamps at
 *  either end instead of wrapping, and from no focus lands on the first
 *  (or, moving up, also the first — there's nothing before it). */
export function moveHunkFocus(
  hunks: { id: HunkId }[],
  focusId: HunkId | null,
  delta: 1 | -1,
): HunkId | null {
  if (!hunks.length) return null;
  const i = focusId ? hunks.findIndex((h) => h.id === focusId) : -1;
  const next = hunks[Math.max(0, Math.min(hunks.length - 1, i + delta))];
  return next ? next.id : null;
}
