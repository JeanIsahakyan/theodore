import { describe, expect, it } from 'vitest';
import type { RepoRef } from '../../gen/contract';
import type { InboxPr } from '../List';
import { branchPr } from './branches';

const repo: RepoRef = { host: 'github', owner: 'acme', name: 'web' };
const otherRepo: RepoRef = { host: 'github', owner: 'acme', name: 'other' };

const pr = (over: Partial<InboxPr> & { id: string }): InboxPr => ({
  pr: { repo, number: 1, host_id: null },
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

describe('branchPr', () => {
  it('is null when no PR shares the branch name', () => {
    expect(branchPr('feature', repo, [])).toBeNull();
  });

  it('matches by head_ref within the same repo', () => {
    const p = pr({ id: '1', head_ref: 'feature' });
    expect(branchPr('feature', repo, [p])).toBe(p);
  });

  it('ignores a same-named branch in a different repo', () => {
    const p = pr({
      id: '1',
      head_ref: 'feature',
      pr: { repo: otherRepo, number: 1, host_id: null },
    });
    expect(branchPr('feature', repo, [p])).toBeNull();
  });

  it('prefers an open PR over a stale closed one with the same branch name', () => {
    const closed = pr({
      id: '1',
      head_ref: 'feature',
      state: 'closed',
      updated_at: 99,
    });
    const open = pr({
      id: '2',
      head_ref: 'feature',
      state: 'open',
      updated_at: 1,
    });
    expect(branchPr('feature', repo, [closed, open])).toBe(open);
  });

  it('falls back to the most recently updated match when none are open', () => {
    const older = pr({
      id: '1',
      head_ref: 'feature',
      state: 'closed',
      updated_at: 1,
    });
    const newer = pr({
      id: '2',
      head_ref: 'feature',
      state: 'merged',
      updated_at: 2,
    });
    expect(branchPr('feature', repo, [older, newer])).toBe(newer);
  });
});
