import { describe, expect, it } from 'vitest';
import type { RepoRef } from '../../gen/contract';
import type { InboxPr } from '../List';
import { noOpenPrsBanner, projectStats } from './stats';

const repo: RepoRef = { host: 'github', owner: 'acme', name: 'web' };

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

const DAY = 24 * 60 * 60 * 1000;

describe('projectStats', () => {
  it('counts open and draft PRs together as "open"', () => {
    const items = [
      pr({ id: '1', state: 'open' }),
      pr({ id: '2', state: 'draft' }),
      pr({ id: '3', state: 'closed' }),
    ];
    expect(projectStats(items, null, 0).open).toBe(2);
  });

  it('counts review-requested open PRs as needing review', () => {
    const items = [
      pr({ id: '1', reasons: ['review_requested'] }),
      pr({ id: '2', reasons: ['team_review_requested'] }),
      pr({ id: '3', reasons: [] }),
    ];
    expect(projectStats(items, null, 0).needsReview).toBe(2);
  });

  it('counts open PRs authored by the viewer as "yours"', () => {
    const items = [
      pr({ id: '1', author: { login: 'me', name: null, avatar_url: null } }),
      pr({ id: '2', author: { login: 'them', name: null, avatar_url: null } }),
    ];
    expect(projectStats(items, 'me', 0).yours).toBe(1);
  });

  it('counts failing checks among open PRs only', () => {
    const items = [
      pr({ id: '1', checks: 'fail' }),
      pr({ id: '2', checks: 'fail', state: 'closed' }),
    ];
    expect(projectStats(items, null, 0).failingChecks).toBe(1);
  });

  it('counts merges within the last 7 days', () => {
    const now = 10 * DAY;
    const items = [
      pr({ id: '1', state: 'merged', updated_at: now - DAY }),
      pr({ id: '2', state: 'merged', updated_at: now - 8 * DAY }),
    ];
    expect(projectStats(items, null, now).merged7d).toBe(1);
  });
});

describe('noOpenPrsBanner', () => {
  it('is null when there is any open or draft PR', () => {
    expect(noOpenPrsBanner([pr({ id: '1', state: 'open' })])).toBeNull();
  });

  it('is null with no PRs at all', () => {
    expect(noOpenPrsBanner([])).toBeNull();
  });

  it('surfaces the most recently merged PR when nothing is open', () => {
    const items = [
      pr({
        id: '1',
        state: 'merged',
        updated_at: 5,
        pr: { repo, number: 5, host_id: null },
      }),
      pr({
        id: '2',
        state: 'merged',
        updated_at: 9,
        pr: { repo, number: 9, host_id: null },
      }),
      pr({ id: '3', state: 'closed', updated_at: 100 }),
    ];
    expect(noOpenPrsBanner(items)).toEqual({ number: 9, mergedAt: 9 });
  });
});
