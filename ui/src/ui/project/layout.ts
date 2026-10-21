/** What the Branches page needs to know about a project: whether it's a
 *  local folder, and its working-state line. */
import type { Project, ProjectWorkingState } from '../../gen/contract';

/** A folder on this machine, not a host repo. */
export function isLocalFolder(p: Pick<Project, 'repo' | 'path'>): boolean {
  return p.repo.host === 'local' && !!p.path;
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
