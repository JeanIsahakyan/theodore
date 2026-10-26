import type { PrId } from '../../gen/contract';
import type { useRootStore } from '../../stores/context';

/** Fraction of this PR's loaded (non-hidden) hunks already read. The status
 *  circle fills with it everywhere the PR shows: tab, lists, Peek, header. */
export function readProgress(
  store: ReturnType<typeof useRootStore>,
  pr: PrId,
): number {
  const reads = store.models.hunkReads.byPr(pr);
  const groups = store.models.groupsOf(pr).filter((g) => g.kind !== 'hidden');
  const hunks = groups.flatMap((g) => g.hunks);
  if (!hunks.length) return 0;
  const readSet = new Set(reads.map((r) => r.hunk));
  return hunks.filter((h) => readSet.has(h)).length / hunks.length;
}
