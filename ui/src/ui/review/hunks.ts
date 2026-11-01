/**
 * Pure helpers for what the diff shows and the keyboard-focused hunk: which
 * files and hunks are on screen for the current group/file selection and
 * filters, and where focus moves on J/K. No React, no store — `DiffPane`
 * renders `diffFiles` and J/K steps through `hunksInScope` over the same
 * call, so J/K lands on exactly what's on screen, in the same order.
 */
import type {
  Anchor,
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

/** The hunk a jump to `a`'s line lands on: the one holding that line on
 *  its side, else the first one after it (the line sits in the context gap
 *  above that hunk), else the file's last. `null` when the file isn't in
 *  the diff.
 *
 *  ```text
 *  side new, line 12   h1 new 1..5   h2 new 10..14   →  h2
 *  side new, line 7                                   →  h2 (gap above it)
 *  side new, line 40                                  →  h2 (last)
 *  ```
 */
export function hunkAt(
  rev: Pick<Revision, 'files'>,
  a: Pick<Anchor, 'path' | 'side' | 'line'>,
): { path: string; hunk: Hunk } | null {
  const file = rev.files.find((f) => f.path === a.path);
  if (!file?.hunks.length) return null;
  const span = (h: Hunk) =>
    a.side === 'old'
      ? { start: h.old_start, n: h.old_lines }
      : { start: h.new_start, n: h.new_lines };
  const hunk =
    file.hunks.find((h) => {
      const { start, n } = span(h);
      return a.line >= start && a.line < start + n;
    }) ??
    file.hunks.find((h) => span(h).start > a.line) ??
    file.hunks[file.hunks.length - 1]!;
  return { path: file.path, hunk };
}

/** What a jump to `hunk` changes so the diff shows it. */
export interface JumpView {
  /** The current mode when it already shows the hunk; else the group
   *  holding it, or (files mode, or no group holds it) its file. */
  mode: ReviewMode;
  /** "Since only" would hide it: turn it off. */
  sinceOff: boolean;
  /** A skim group's "Only outliers" would hide it: "Show all". */
  showAll: boolean;
  /** Its group is hidden (collapsed): "Show anyway". */
  showHidden: boolean;
}

export function jumpView(
  rev: Pick<Revision, 'files'>,
  mode: ReviewMode,
  groups: readonly (ViewGroup & { id: string })[],
  /** The diff's filters with `group` selected. */
  filters: (group: string | null) => DiffFilters,
  path: string,
  hunk: HunkId,
): JumpView {
  const groupOf = (m: ReviewMode) =>
    m.mode === 'groups' ? (groups.find((g) => g.id === m.group) ?? null) : null;
  const shown = hunksInScope(
    rev,
    mode,
    groupOf(mode),
    filters(mode.mode === 'groups' ? mode.group : null),
  ).some((h) => h.id === hunk);
  if (shown) {
    return { mode, sinceOff: false, showAll: false, showHidden: false };
  }
  const g =
    mode.mode === 'groups' ? groups.find((x) => x.hunks.includes(hunk)) : null;
  const f = filters(g?.id ?? null);
  return {
    mode: g
      ? { mode: 'groups', group: g.id, file: path }
      : { mode: 'files', group: mode.group, file: path },
    sinceOff: !!f.since && !f.since.has(hunk),
    showAll:
      !!g && showsOnlyOutliers(g, f.allEdits) && !g.outliers.includes(hunk),
    showHidden: !!g && isCollapsed(g, f.hiddenShown),
  };
}
