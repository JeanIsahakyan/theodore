/** Fixed PR sections for a project's Pull requests list — unlike the
 *  Inbox's user-configurable grouping, these always mean the same thing so
 *  the page is legible without a Display popover: each PR lands in exactly
 *  one, in this priority order. */
import type { InboxPr } from '../List';

export type ProjectSection =
  | 'needs_review'
  | 'yours'
  | 'open'
  | 'drafts'
  | 'branches'
  | 'merged'
  | 'closed';

/** A "Review branch" review: a branch with no PR on the host, stored as a
 *  `pr` row with no host URL. Not a pull request — kept out of PR counts. */
export function isBranchReview(p: Pick<InboxPr, 'url'>): boolean {
  return !p.url;
}

const SECTION_TITLE: Record<ProjectSection, string> = {
  needs_review: 'Needs your review',
  yours: 'Yours',
  open: 'Open',
  drafts: 'Drafts',
  branches: 'Branch reviews',
  merged: 'Recently merged',
  closed: 'Closed',
};

/** Display order, and the priority a PR is tested against — a PR assigned
 *  to review stays out of "Yours" even if it's also yours to merge, etc. */
const SECTION_ORDER: ProjectSection[] = [
  'needs_review',
  'yours',
  'open',
  'drafts',
  'branches',
  'merged',
  'closed',
];

function sectionOf(p: InboxPr, viewerLogin: string | null): ProjectSection {
  if (isBranchReview(p)) return 'branches';
  const openish = p.state === 'open' || p.state === 'draft';
  const needsReview =
    openish &&
    (p.reasons.includes('review_requested') ||
      p.reasons.includes('team_review_requested'));
  if (needsReview) return 'needs_review';
  if (openish && viewerLogin != null && p.author.login === viewerLogin) {
    return 'yours';
  }
  if (p.state === 'open') return 'open';
  if (p.state === 'draft') return 'drafts';
  if (p.state === 'merged') return 'merged';
  return 'closed';
}

export type ProjectPrSort = 'activity' | 'size';

function sortItems(items: InboxPr[], sort: ProjectPrSort): InboxPr[] {
  const by =
    sort === 'size'
      ? (p: InboxPr) => -(p.additions + p.deletions)
      : (p: InboxPr) => -p.updated_at;
  return [...items].sort((a, b) => by(a) - by(b));
}

export interface ProjectPrGroup {
  id: ProjectSection;
  title: string;
  items: InboxPr[];
  /** "Recently merged" starts collapsed when there's any open-ish work to
   *  show first — nothing to collapse when it's the only thing going on. */
  collapsedByDefault: boolean;
}

export function projectPrSections(
  items: InboxPr[],
  viewerLogin: string | null,
  sort: ProjectPrSort = 'activity',
): ProjectPrGroup[] {
  const hasOpenWork = items.some(
    (p) => p.state === 'open' || p.state === 'draft',
  );
  return SECTION_ORDER.map((id) => ({
    id,
    title: SECTION_TITLE[id],
    items: sortItems(
      items.filter((p) => sectionOf(p, viewerLogin) === id),
      sort,
    ),
    collapsedByDefault: id === 'merged' && hasOpenWork,
  }));
}
