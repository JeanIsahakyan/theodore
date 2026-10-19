import { describe, expect, it } from 'vitest';
import type { HostRepo, PrState, Project, RepoRef } from '../gen/contract';
import type { InboxPr } from './List';
import {
  boardColumns,
  filterHostRepos,
  groupProjectPrs,
  projectLabel,
  repoKey,
  sameRepo,
} from './Projects';

const repo = (over: Partial<RepoRef> = {}): RepoRef => ({
  host: 'github',
  owner: 'acme',
  name: 'web',
  ...over,
});

const hostRepo = (over: Partial<RepoRef> = {}): HostRepo => ({
  repo: repo(over),
  description: null,
  private: false,
  pushed_at: null,
});

const project = (over: Partial<Project> = {}): Project => ({
  id: 'github:acme/web',
  repo: repo(),
  path: null,
  status: 'ready',
  error: null,
  default_branch: 'main',
  added_at: 0,
  ...over,
});

const pr = (over: Partial<InboxPr> & { id: string }): InboxPr => ({
  pr: { repo: repo(), number: 1, host_id: null },
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

describe('repoKey / sameRepo', () => {
  it('keys a repo by host:owner/name', () => {
    expect(repoKey(repo())).toBe('github:acme/web');
  });

  it('treats same host/owner/name as the same repo', () => {
    expect(sameRepo(repo(), repo())).toBe(true);
    expect(sameRepo(repo(), repo({ name: 'api' }))).toBe(false);
    expect(sameRepo(repo(), repo({ host: 'gitlab' }))).toBe(false);
  });
});

describe('projectLabel', () => {
  it('is "owner/name" for a host project', () => {
    expect(projectLabel(project())).toBe('acme/web');
  });

  it('is just the folder name for a local project', () => {
    expect(
      projectLabel(
        project({ repo: repo({ host: 'local', owner: '', name: 'my-repo' }) }),
      ),
    ).toBe('my-repo');
  });
});

describe('filterHostRepos', () => {
  const repos = [
    hostRepo({ name: 'web' }),
    hostRepo({ name: 'api' }),
    hostRepo({ owner: 'other', name: 'tool' }),
  ];

  it('returns everything for an empty query', () => {
    expect(filterHostRepos(repos, '')).toHaveLength(3);
    expect(filterHostRepos(repos, '   ')).toHaveLength(3);
  });

  it('matches on "owner/name", case-insensitively', () => {
    expect(filterHostRepos(repos, 'ACME/W')).toEqual([
      hostRepo({ name: 'web' }),
    ]);
    expect(filterHostRepos(repos, 'other')).toEqual([
      hostRepo({ owner: 'other', name: 'tool' }),
    ]);
  });

  it('matches nothing when the query misses', () => {
    expect(filterHostRepos(repos, 'nope')).toEqual([]);
  });
});

describe('groupProjectPrs', () => {
  const items = [
    pr({ id: '1', state: 'open', updated_at: 1 }),
    pr({ id: '2', state: 'merged', updated_at: 3 }),
    pr({ id: '3', state: 'open', updated_at: 2 }),
  ];

  it('groups by status, in STATUS_ORDER, each sorted by activity', () => {
    const groups = groupProjectPrs(items, {
      groupBy: 'status',
      sort: 'activity',
    });
    const nonEmpty = groups.filter((g) => g.items.length);
    expect(nonEmpty.map((g) => g.id)).toEqual(['open', 'merged']);
    expect(nonEmpty[0]!.items.map((p) => p.id)).toEqual(['3', '1']);
  });

  it('collapses to one group when groupBy is none', () => {
    const groups = groupProjectPrs(items, {
      groupBy: 'none',
      sort: 'activity',
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items).toHaveLength(3);
  });

  it('sorts by size (additions + deletions) when asked', () => {
    const bySize = [
      pr({ id: 'a', additions: 1, deletions: 0 }),
      pr({ id: 'b', additions: 10, deletions: 0 }),
    ];
    const groups = groupProjectPrs(bySize, { groupBy: 'none', sort: 'size' });
    expect(groups[0]!.items.map((p) => p.id)).toEqual(['b', 'a']);
  });
});

describe('boardColumns', () => {
  const states: PrState[] = ['draft', 'open', 'merged', 'closed'];

  it('always has one column per PrState, in order', () => {
    const cols = boardColumns([], 'activity');
    expect(cols.map((c) => c.status)).toEqual(states);
  });

  it('buckets items by their own status, not groupBy', () => {
    const items = [
      pr({ id: '1', state: 'draft' }),
      pr({ id: '2', state: 'closed' }),
    ];
    const cols = boardColumns(items, 'activity');
    expect(
      cols.find((c) => c.status === 'draft')?.items.map((p) => p.id),
    ).toEqual(['1']);
    expect(
      cols.find((c) => c.status === 'closed')?.items.map((p) => p.id),
    ).toEqual(['2']);
    expect(cols.find((c) => c.status === 'open')?.items).toEqual([]);
  });
});
