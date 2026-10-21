import { describe, expect, it } from 'vitest';
import type { PrSummary, RepoRef } from '../gen/contract';
import { projectPeekActions } from './Peek';

const github: RepoRef = { host: 'github', owner: 'acme', name: 'web' };

const pr = (over: Partial<PrSummary> = {}): PrSummary => ({
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
  reasons: ['review_requested'],
  checks: 'pass',
  approvals: 1,
  required_approvals: 1,
  updated_at: 0,
  url: 'https://github.com/acme/web/pull/1',
  ...over,
});

describe('projectPeekActions', () => {
  it('offers Open, Merge and Reviewers on a mergeable open PR, no triage', () => {
    // A review request would put Take/Snooze/Done in the inbox; a project
    // page shows its own actions only.
    expect(projectPeekActions(pr(), true)).toEqual([
      'open',
      'merge',
      'reviewers',
    ]);
  });

  it('drops Merge while a gate is red', () => {
    expect(projectPeekActions(pr({ checks: 'fail' }), true)).toEqual([
      'open',
      'reviewers',
    ]);
    expect(projectPeekActions(pr({ approvals: 0 }), true)).toEqual([
      'open',
      'reviewers',
    ]);
    expect(projectPeekActions(pr({ conflicts: true }), true)).toEqual([
      'open',
      'reviewers',
    ]);
  });

  it('keeps Reviewers on a draft but never offers Merge on one', () => {
    expect(projectPeekActions(pr({ state: 'draft' }), true)).toEqual([
      'open',
      'reviewers',
    ]);
  });

  it('only opens a merged PR or a branch review', () => {
    expect(projectPeekActions(pr({ state: 'merged' }), true)).toEqual(['open']);
    expect(projectPeekActions(pr({ url: '' }), true)).toEqual(['open']);
    expect(
      projectPeekActions(
        pr({
          url: '',
          pr: {
            repo: { host: 'local', owner: 'local', name: 'web' },
            number: 9,
            host_id: 'feature',
          },
        }),
        true,
      ),
    ).toEqual(['open']);
  });

  it('hides Reviewers when host writes are off', () => {
    expect(projectPeekActions(pr(), false)).toEqual(['open', 'merge']);
  });
});
