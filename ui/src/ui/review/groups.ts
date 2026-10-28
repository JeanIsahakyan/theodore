/**
 * Pure helpers for group ordering and the hidden/mechanical-group collapse —
 * no React, no store, easy to unit test. `hidden` groups (lockfiles,
 * generated code — see `GroupKind` in the contract) are always listed, but
 * collapsed in the diff by default and skipped by `N`/`P` navigation; the
 * user can still open one with "show anyway".
 */
import type { Group, HunkId } from '../../gen/contract';

/** Groups restricted to this revision, in reading order: each group keeps
 *  only the hunks the revision has (an older grouping can name hunks a push
 *  removed), and a group left with none is dropped. A group with every hunk
 *  present is returned as is. Includes hidden groups — `GroupsPane` still
 *  lists them (collapsed). */
export function groupsInRevision(
  groups: Group[],
  hunkIds: ReadonlySet<HunkId>,
): Group[] {
  const out: Group[] = [];
  for (const g of groups) {
    const hunks = g.hunks.filter((h) => hunkIds.has(h));
    if (!hunks.length) continue;
    if (hunks.length === g.hunks.length) {
      out.push(g);
      continue;
    }
    out.push({
      ...g,
      hunks,
      outliers: g.outliers.filter((h) => hunkIds.has(h)),
    });
  }
  return out;
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
 *  its hunks is (the same read-state the group checkmarks use). While the
 *  grouping is still being written (`complete` false) more groups are
 *  coming: it is never "all read" then. */
export function groupsProgress(
  groups: Group[],
  readHunks: ReadonlySet<HunkId>,
  complete = true,
): { read: number; total: number; all: boolean; label: string } {
  const reviewable = reviewableGroups(groups);
  const total = reviewable.length;
  const read = reviewable.filter((g) =>
    g.hunks.every((h) => readHunks.has(h)),
  ).length;
  const all = complete && total > 0 && read === total;
  const label = all
    ? 'All groups read'
    : `${read} of ${total} group${total === 1 ? '' : 's'} read${complete ? '' : ' so far'}`;
  return { read, total, all, label };
}

/** Reading order that doesn't move what the user is on. Streamed grouping
 *  replaces the whole row as groups arrive and the final pass may reorder
 *  them; a group in `anchored` (opened, or partly read) keeps the slot it
 *  had in `prev` — the order last shown — and every other group fills the
 *  free slots in `next`'s order. Returns `next` itself when nothing has to
 *  stay put.
 *
 *  ```text
 *  prev  [A* B]          A* opened
 *  next  [C A D B]       final order
 *  out   [A C D B]       A keeps slot 0, the rest in next's order
 *  ```
 */
export function stableOrder(
  prev: readonly string[],
  next: Group[],
  anchored: ReadonlySet<string>,
): Group[] {
  const byId = new Map(next.map((g) => [g.id, g]));
  const pins: [number, Group][] = [];
  prev.forEach((id, i) => {
    const g = byId.get(id);
    if (g && anchored.has(id)) pins.push([i, g]);
  });
  if (!pins.length) return next;
  const out: (Group | undefined)[] = new Array(next.length);
  for (const [i, g] of pins) {
    let at = Math.min(i, next.length - 1);
    while (at < next.length && out[at]) at++;
    if (at === next.length) at = out.findIndex((x) => !x);
    out[at] = g;
  }
  const pinned = new Set(pins.map(([, g]) => g.id));
  const rest = next.filter((g) => !pinned.has(g.id));
  let k = 0;
  for (let i = 0; i < out.length; i++) if (!out[i]) out[i] = rest[k++];
  const result = out as Group[];
  return result.every((g, i) => g === next[i]) ? next : result;
}
