/** Pure stat-card and empty-state computations for a project's header —
 *  split out from `Projects.tsx` so they're covered by vitest without a
 *  DOM. */
import type { InboxPr } from '../List';
import { isBranchReview } from './sections';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface ProjectStats {
  open: number;
  needsReview: number;
  yours: number;
  failingChecks: number;
  merged7d: number;
}

/** The five stat cards under the project header. "Open" counts drafts too
 *  (GitHub's own convention); the others are subsets of it except
 *  "Merged 7d", which looks at merged PRs instead. */
export function projectStats(
  items: InboxPr[],
  viewerLogin: string | null,
  now: number,
): ProjectStats {
  // Branch reviews aren't pull requests: they don't count as open PRs.
  const openish = items.filter(
    (p) => (p.state === 'open' || p.state === 'draft') && !isBranchReview(p),
  );
  return {
    open: openish.length,
    needsReview: openish.filter(
      (p) =>
        p.reasons.includes('review_requested') ||
        p.reasons.includes('team_review_requested'),
    ).length,
    yours: openish.filter(
      (p) => viewerLogin != null && p.author.login === viewerLogin,
    ).length,
    failingChecks: openish.filter((p) => p.checks === 'fail').length,
    merged7d: items.filter(
      (p) => p.state === 'merged' && now - p.updated_at <= SEVEN_DAYS_MS,
    ).length,
  };
}

/** When there's nothing open right now (the common case for a repo that
 *  merges within the hour, e.g. linqx-v2): the most recently merged PR, so
 *  the empty list can say "No open PRs · last merge Nm ago (#N)" instead
 *  of just sitting blank. */
export function noOpenPrsBanner(
  items: InboxPr[],
): { number: number; mergedAt: number } | null {
  if (
    items.some(
      (p) => (p.state === 'open' || p.state === 'draft') && !isBranchReview(p),
    )
  ) {
    return null;
  }
  const merged = items
    .filter((p) => p.state === 'merged')
    .sort((a, b) => b.updated_at - a.updated_at);
  const latest = merged[0];
  return latest
    ? { number: latest.pr.number, mergedAt: latest.updated_at }
    : null;
}
