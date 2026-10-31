/**
 * Pure helpers for what the diff shows and the keyboard-focused hunk: which
 * files and hunks are on screen for the current group/file selection and
 * filters, and where focus moves on J/K. No React, no store — `DiffPane`
 * renders `diffFiles` and J/K steps through `hunksInScope` over the same
 * call, so J/K lands on exactly what's on screen, in the same order.
 */
import type {
  FileDiff,
  Group,
  Hunk,
  HunkId,
  Revision,
} from '../../gen/contract';
import type { ReviewMode } from '../GroupsPane';
import { groupDiff } from './groups';

/** The diff's filters on top of the group/file selection. */
export interface DiffFilters {
  /** "Since only": the hunks changed since the last visit; `null` when
   *  it's off and every hunk shows. */
  since: { has(h: HunkId): boolean } | null;
  /** The user pressed "Show all" on a skim group, past its default
   *  "Only outliers". */
  allEdits: boolean;
  /** The user pressed "Show anyway" on a hidden group. */
  hiddenShown: boolean;
}

type ViewGroup = Pick<Group, 'hunks' | 'outliers' | 'kind'>;

/** A skim group shows only its off-pattern hunks until "Show all". */
export function showsOnlyOutliers(
  group: ViewGroup | null,
  allEdits: boolean,
): boolean {
  return (
    !!group && group.kind === 'skim' && group.outliers.length > 0 && !allEdits
  );
}

/** A hidden group (lockfiles, generated code) stays collapsed — none of its
 *  diff shows — until "Show anyway". */
export function isCollapsed(
  group: ViewGroup | null,
  hiddenShown: boolean,
): boolean {
  return !!group && group.kind === 'hidden' && !hiddenShown;
}

/** The files the diff shows, each with only the hunks it shows, in order.
 *  A group's files come in `groupDiff`'s order over the hunks left after
 *  "Since only" — the groups pane's order — so a file is placed by its
 *  first hunk changed since, not by its first in the whole group:
 *
 *  ```text
 *  group  [a1 b1 a2]     a.ts [a1 a2], b.ts [b1]
 *  since  {b1 a2}
 *  out    b.ts [b1], a.ts [a2]
 *  ```
 *
 *  "Only outliers" then drops the rest of a skim group's hunks, keeping
 *  that order: off-pattern files already come first. */
export function diffFiles(
  rev: Pick<Revision, 'files'>,
  mode: Pick<ReviewMode, 'mode' | 'file'>,
  group: ViewGroup | null,
  { since, allEdits, hiddenShown }: DiffFilters,
): FileDiff[] {
  if (mode.mode !== 'files' && isCollapsed(group, hiddenShown)) return [];
  let out: FileDiff[] =
    mode.mode === 'files'
      ? rev.files.filter((f) => f.path === mode.file)
      : group
        ? groupDiff(
            rev.files,
            since ? group.hunks.filter((h) => since.has(h)) : group.hunks,
            group.outliers,
          )
        : rev.files;
  const keep = (pred: (h: Hunk) => boolean) =>
    out
      .map((f) => ({ ...f, hunks: f.hunks.filter(pred) }))
      .filter((f) => f.hunks.length);
  if (mode.mode !== 'files' && showsOnlyOutliers(group, allEdits)) {
    const off = new Set(group!.outliers);
    out = keep((h) => off.has(h.id));
  }
  if (since) out = keep((h) => since.has(h.id));
  return out;
}

/** Every hunk the diff shows, in the order it shows them — what J/K steps
 *  through. */
export function hunksInScope(
  rev: Pick<Revision, 'files'>,
  mode: ReviewMode,
  group: ViewGroup | null,
  filters: DiffFilters,
): Hunk[] {
  return diffFiles(rev, mode, group, filters).flatMap((f) => f.hunks);
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
