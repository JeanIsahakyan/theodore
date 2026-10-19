import { describe, expect, it } from 'vitest';
import type { RepoRef } from '../../gen/contract';
import type { InboxPr } from '../List';
import {
  failingChecksCount,
  mergesPerWeek,
  oldestOpenPrAge,
  topAuthors,
} from './summary';

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
const WEEK = 7 * DAY;

describe('mergesPerWeek', () => {
  it('buckets merged PRs into 4 weeks, oldest first', () => {
    const now = 4 * WEEK;
    const items = [
      pr({ id: '1', state: 'merged', updated_at: now - 1 }), // this week
      pr({ id: '2', state: 'merged', updated_at: now - WEEK - 1 }), // 1 week ago
      pr({ id: '3', state: 'merged', updated_at: now - 3 * WEEK - 1 }), // 3 weeks ago
    ];
    expect(mergesPerWeek(items, now)).toEqual([1, 0, 1, 1]);
  });

  it('ignores merges older than 4 weeks and non-merged PRs', () => {
    const now = 4 * WEEK;
    const items = [
      pr({ id: '1', state: 'merged', updated_at: now - 5 * WEEK }),
      pr({ id: '2', state: 'open', updated_at: now - 1 }),
    ];
    expect(mergesPerWeek(items, now)).toEqual([0, 0, 0, 0]);
  });
});

describe('topAuthors', () => {
  it('counts PRs per author, most active first', () => {
    const items = [
      pr({ id: '1', author: { login: 'a', name: null, avatar_url: null } }),
      pr({ id: '2', author: { login: 'a', name: null, avatar_url: null } }),
      pr({ id: '3', author: { login: 'b', name: null, avatar_url: null } }),
    ];
    expect(topAuthors(items)).toEqual([
      { login: 'a', count: 2 },
      { login: 'b', count: 1 },
    ]);
  });

  it('caps at the requested limit', () => {
    const items = ['a', 'b', 'c'].map((login, i) =>
      pr({ id: String(i), author: { login, name: null, avatar_url: null } }),
    );
    expect(topAuthors(items, 2)).toHaveLength(2);
  });
});

describe('failingChecksCount', () => {
  it('counts only open/draft PRs with failing checks', () => {
    const items = [
      pr({ id: '1', checks: 'fail' }),
      pr({ id: '2', checks: 'fail', state: 'closed' }),
      pr({ id: '3', checks: 'pass' }),
    ];
    expect(failingChecksCount(items)).toBe(1);
  });
});

describe('oldestOpenPrAge', () => {
  it('is null with nothing open', () => {
    expect(oldestOpenPrAge([pr({ id: '1', state: 'closed' })], 0)).toBeNull();
  });

  it('picks the least-recently-updated open PR', () => {
    const now = 10 * DAY;
    const items = [
      pr({
        id: '1',
        updated_at: now - DAY,
        pr: { repo, number: 1, host_id: null },
      }),
      pr({
        id: '2',
        updated_at: now - 5 * DAY,
        pr: { repo, number: 2, host_id: null },
      }),
    ];
    expect(oldestOpenPrAge(items, now)).toEqual({ number: 2, ageMs: 5 * DAY });
  });

  it('prefers created_at over updated_at when the host filled it', () => {
    const now = 10 * DAY;
    const items = [
      // Updated recently but opened long ago: the real age is 9 days, not 1.
      pr({
        id: '1',
        created_at: now - 9 * DAY,
        updated_at: now - DAY,
        pr: { repo, number: 1, host_id: null },
      }),
      // No created_at: falls back to updated_at, and is "younger" than #1.
      pr({
        id: '2',
        updated_at: now - 2 * DAY,
        pr: { repo, number: 2, host_id: null },
      }),
    ];
    expect(oldestOpenPrAge(items, now)).toEqual({ number: 1, ageMs: 9 * DAY });
  });
});
