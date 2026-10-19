/**
 * Pure helpers for the re-review panel: indexing the core's `interdiff`
 * response by hunk, and deciding whether a hunk has a word-diff worth
 * showing. No React, no store.
 */
import type { HunkId, InterdiffEntry } from '../../gen/contract';
import { interdiffLines, type MarkedLine } from '../diff';

/** Looks up by the *current* revision's hunk id for `new` / `changed` /
 *  `unchanged`; `vanished` entries key by the baseline's hunk id instead
 *  (they have no current-side hunk), so they never collide with one. */
export function interdiffByHunk(
  entries: InterdiffEntry[],
): Map<HunkId, InterdiffEntry> {
  return new Map(entries.map((e) => [e.hunk, e]));
}

export interface InterdiffView {
  previous: MarkedLine[];
  now: MarkedLine[];
}

/** `null` when there's nothing to show: no entry for this hunk, it isn't a
 *  `changed` hunk, or the backend had no word-diff for it. */
export function interdiffView(
  entry: InterdiffEntry | undefined,
): InterdiffView | null {
  if (!entry || entry.class !== 'changed' || !entry.words.length) return null;
  return interdiffLines(entry.words);
}
