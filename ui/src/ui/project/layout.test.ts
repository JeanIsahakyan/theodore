import { describe, expect, it } from 'vitest';
import type { RepoRef } from '../../gen/contract';
import type { InboxPr } from '../List';
import {
  hasPullRequests,
  isLocalFolder,
  projectTabs,
  showStatCards,
  workingStateParts,
} from './layout';

const local: RepoRef = { host: 'local', owner: 'local', name: 'web' };
const github: RepoRef = { host: 'github', owner: 'acme', name: 'web' };

const pr = (over: Partial<InboxPr> & { id: string }): InboxPr => ({
  pr: { repo: github, number: 1, host_id: null },
  title: 'a change',
  author: { login: 'me', name: null, avatar_url: null },
  state: 'open',
  base_ref: 'main',
  head_ref: 'feature',
  head_sha: 'abc',
  additions: 1,
  deletions: 1,
  changed_files: 1,
  reasons: [],
  checks: 'none',
  approvals: 0,
  required_approvals: null,
  updated_at: 0,
  url: 'https://github.com/acme/web/pull/1',
  ...over,
});

const branchReview = (id: string): InboxPr =>
  pr({ id, url: '', pr: { repo: local, number: 7, host_id: 'feature' } });

describe('isLocalFolder', () => {
  it('is a local repo with a folder path', () => {
    expect(isLocalFolder({ repo: local, path: '/src/web' })).toBe(true);
    expect(isLocalFolder({ repo: github, path: null })).toBe(false);
    expect(isLocalFolder({ repo: local, path: null })).toBe(false);
  });
});

describe('hasPullRequests', () => {
  it('ignores branch reviews', () => {
    expect(hasPullRequests([])).toBe(false);
    expect(hasPullRequests([branchReview('b')])).toBe(false);
    expect(hasPullRequests([branchReview('b'), pr({ id: '1' })])).toBe(true);
  });
});

describe('showStatCards', () => {
  it('shows the cards only while host PRs are open', () => {
    expect(showStatCards([])).toBe(false);
    expect(showStatCards([branchReview('b')])).toBe(false);
    // Only merged: the "No open PRs · last merge" banner says it instead.
    expect(showStatCards([pr({ id: 'm', state: 'merged' })])).toBe(false);
    expect(showStatCards([pr({ id: 'd', state: 'draft' })])).toBe(true);
    expect(showStatCards([pr({ id: 'o' })])).toBe(true);
  });
});

describe('projectTabs', () => {
  it('keeps all three tabs for a host repo, PRs first', () => {
    expect(projectTabs(false, [])).toEqual(['prs', 'branches', 'activity']);
  });

  it('opens a local folder on Branches, with no empty PR or Activity tab', () => {
    expect(projectTabs(true, [])).toEqual(['branches']);
  });

  it('adds the list tab once a local folder has a branch review', () => {
    // Branch reviews aren't host activity: Activity stays hidden.
    expect(projectTabs(true, [branchReview('b')])).toEqual(['branches', 'prs']);
  });
});

describe('workingStateParts', () => {
  it('says "checked out", never passing the branch off as the default', () => {
    expect(
      workingStateParts({ current_branch: 'feature', dirty_files: 3 }, 'main'),
    ).toEqual(['checked out feature', '3 uncommitted files', 'default main']);
  });

  it('handles a clean tree, one file and a detached HEAD', () => {
    expect(
      workingStateParts({ current_branch: 'main', dirty_files: 0 }, 'main'),
    ).toEqual(['checked out main', 'clean', 'default main']);
    expect(
      workingStateParts({ current_branch: null, dirty_files: 1 }, null),
    ).toEqual(['detached HEAD', '1 uncommitted file']);
  });

  it('still shows the default branch before the state has loaded', () => {
    expect(workingStateParts(null, 'main')).toEqual(['default main']);
  });
});
