import { describe, expect, it } from 'vitest';
import type { PrSummary, RepoRef } from '../gen/contract';
import { peekHostActions } from './Peek';

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

describe('peekHostActions', () => {
  it('offers Merge and Reviewers on a mergeable open PR', () => {
    expect(peekHostActions(pr(), true)).toEqual(['merge', 'reviewers']);
  });

  it('drops Merge while a gate is red', () => {
    expect(peekHostActions(pr({ checks: 'fail' }), true)).toEqual([
      'reviewers',
    ]);
    expect(peekHostActions(pr({ approvals: 0 }), true)).toEqual(['reviewers']);
    expect(peekHostActions(pr({ conflicts: true }), true)).toEqual([
      'reviewers',
    ]);
  });

  it('keeps Reviewers on a draft but never offers Merge on one', () => {
    expect(peekHostActions(pr({ state: 'draft' }), true)).toEqual([
      'reviewers',
    ]);
  });

  it('offers nothing on a merged PR or a branch review', () => {
    expect(peekHostActions(pr({ state: 'merged' }), true)).toEqual([]);
    expect(peekHostActions(pr({ url: '' }), true)).toEqual([]);
    expect(
      peekHostActions(
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
    ).toEqual([]);
  });

  it('hides Reviewers when host writes are off', () => {
    expect(peekHostActions(pr(), false)).toEqual(['merge']);
  });
});
