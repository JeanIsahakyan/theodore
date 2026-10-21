/** What a project page shows, from what the project has: a local folder
 *  opens on Branches and drops the PR-only parts that would sit empty; a
 *  host repo keeps all three tabs. */
import type { Project, ProjectWorkingState } from '../../gen/contract';
import type { InboxPr } from '../List';
import { projectActivity } from './activity';
import { isBranchReview } from './sections';

export type ProjectTab = 'prs' | 'branches' | 'activity';

/** A folder on this machine, not a host repo. */
export function isLocalFolder(p: Pick<Project, 'repo' | 'path'>): boolean {
  return p.repo.host === 'local' && !!p.path;
}

/** Real host pull requests, not branch reviews. */
export function hasPullRequests(items: InboxPr[]): boolean {
  return items.some((p) => !isBranchReview(p));
}

/** Tabs in display order; the first is where the page opens. A local
 *  folder has no host PRs: its list tab only appears once a branch review
 *  exists, and Activity (host PR events) only if there are any. */
export function projectTabs(local: boolean, items: InboxPr[]): ProjectTab[] {
  if (!local) return ['prs', 'branches', 'activity'];
  const tabs: ProjectTab[] = ['branches'];
  if (items.length) tabs.push('prs');
  if (projectActivity(items).length) tabs.push('activity');
  return tabs;
}

/** The header's working-state line for a local folder: the checked-out
 *  branch (said as such, never as the default), uncommitted paths, then
 *  the default branch. */
export function workingStateParts(
  state: Pick<ProjectWorkingState, 'current_branch' | 'dirty_files'> | null,
  defaultBranch: string | null,
): string[] {
  const parts: string[] = [];
  if (state) {
    parts.push(
      state.current_branch
        ? `checked out ${state.current_branch}`
        : 'detached HEAD',
    );
    parts.push(
      state.dirty_files === 0
        ? 'clean'
        : `${state.dirty_files} uncommitted ${state.dirty_files === 1 ? 'file' : 'files'}`,
    );
  }
  if (defaultBranch) parts.push(`default ${defaultBranch}`);
  return parts;
}
