/**
 * The Pull requests page: one list of the active workspace's PRs, cut by a
 * filter at the top. Pure, so the stores and the view share it.
 *
 * | filter | rows                         | groups                          |
 * |--------|------------------------------|---------------------------------|
 * | all    | open + draft, branch reviews | the project sections; "Branch   |
 * |        |                              | reviews" starts collapsed       |
 * | mine   | authored by you, any state   | next step (merge, your move …)  |
 * | drafts | drafts                       | one                             |
 * | merged | merged, most recent first    | one                             |
 */
import type { Project } from '../../gen/contract';
import { inWorkspace, type WorkspaceId } from '../../core/workspaces';
import type { InboxPr } from '../List';
import { isBranchReview, projectPrSections } from '../project/sections';
import { STEPS, nextStep } from './mine';

export type PrFilter = 'all' | 'mine' | 'drafts' | 'merged';

export const PR_FILTERS: { id: PrFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'mine', label: 'Mine' },
  { id: 'drafts', label: 'Drafts' },
  { id: 'merged', label: 'Merged' },
];

export function isPrFilter(v: unknown): v is PrFilter {
  return PR_FILTERS.some((f) => f.id === v);
}

export interface PrGroup {
  id: string;
  title: string;
  items: InboxPr[];
  /** Starts collapsed: branch reviews, and your merged / closed PRs. */
  collapsed: boolean;
}

const openish = (p: InboxPr) => p.state === 'open' || p.state === 'draft';
const recentFirst = (items: InboxPr[]) =>
  [...items].sort((a, b) => b.updated_at - a.updated_at);

/** The rows a workspace shows: All every PR, a project its own repo's. */
export function scopeToWorkspace(
  prs: InboxPr[],
  ws: WorkspaceId,
  projects: Project[],
): InboxPr[] {
  return prs.filter((p) => inWorkspace(ws, p.pr.repo, projects));
}

/** Open pull requests (drafts included, branch reviews not): the sidebar
 *  badge, the "All" filter's count. */
export function openPrCount(prs: InboxPr[]): number {
  return prs.filter((p) => openish(p) && !isBranchReview(p)).length;
}

/** Non-empty groups of `prs` (already scoped) under `filter`. `viewer` is
 *  the signed-in host login; with none, "Mine" is empty. */
export function prGroups(
  prs: InboxPr[],
  filter: PrFilter,
  viewer: string | null,
): PrGroup[] {
  const real = prs.filter((p) => !isBranchReview(p));
  let groups: PrGroup[];
  switch (filter) {
    case 'all': {
      const rows = prs.filter((p) => isBranchReview(p) || openish(p));
      groups = projectPrSections(rows, viewer).map((g) => ({
        id: g.id,
        title: g.title,
        items: g.items,
        collapsed: g.id === 'branches',
      }));
      break;
    }
    case 'mine': {
      const mine = viewer
        ? recentFirst(real.filter((p) => p.author.login === viewer))
        : [];
      groups = STEPS.map((s) => ({
        id: s.id,
        title: s.title,
        items: mine.filter((p) => nextStep(p) === s.id),
        collapsed: s.id === 'merged' || s.id === 'closed',
      }));
      break;
    }
    case 'drafts':
      groups = [
        {
          id: 'drafts',
          title: 'Drafts',
          items: recentFirst(real.filter((p) => p.state === 'draft')),
          collapsed: false,
        },
      ];
      break;
    case 'merged':
      groups = [
        {
          id: 'merged',
          title: 'Recently merged',
          items: recentFirst(real.filter((p) => p.state === 'merged')),
          collapsed: false,
        },
      ];
      break;
  }
  return groups.filter((g) => g.items.length);
}

/** The page header's count: open PRs under All and Mine (yours only),
 *  every row under Drafts and Merged. */
export function filterCount(
  prs: InboxPr[],
  filter: PrFilter,
  viewer: string | null,
): number {
  if (filter === 'all') return openPrCount(prs);
  if (filter === 'mine')
    return viewer
      ? openPrCount(prs.filter((p) => p.author.login === viewer))
      : 0;
  return prGroups(prs, filter, viewer).reduce((n, g) => n + g.items.length, 0);
}
