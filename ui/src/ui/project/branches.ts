/** Matches a local branch to a PR row of the same repo, for the Branches
 *  tab's "has PR #n" link — a plain name/repo match against `head_ref`,
 *  preferring an open PR over a stale closed one with the same name. */
import type { RepoRef } from '../../gen/contract';
import type { InboxPr } from '../List';
import { isBranchReview } from './sections';

export function branchPr(
  branchName: string,
  repo: RepoRef,
  items: InboxPr[],
): InboxPr | null {
  const matches = items.filter(
    (p) =>
      p.pr.repo.host === repo.host &&
      p.pr.repo.owner === repo.owner &&
      p.pr.repo.name === repo.name &&
      p.head_ref === branchName &&
      // a branch review of this branch isn't a PR for it
      !isBranchReview(p),
  );
  if (!matches.length) return null;
  const open = matches.find((p) => p.state === 'open' || p.state === 'draft');
  if (open) return open;
  return [...matches].sort((a, b) => b.updated_at - a.updated_at)[0]!;
}
