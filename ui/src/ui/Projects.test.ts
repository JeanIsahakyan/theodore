import { describe, expect, it } from 'vitest';
import type { HostRepo, Project, RepoRef } from '../gen/contract';
import {
  filterHostRepos,
  groupByOwner,
  hostRepoUrl,
  projectLabel,
  repoKey,
  selectableRepoKeys,
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

describe('selectableRepoKeys', () => {
  it('uses owner-grouped display order and excludes added repositories', () => {
    const repos = [
      { ...hostRepo({ name: 'api' }), pushed_at: 1 },
      { ...hostRepo({ name: 'web' }), pushed_at: 9 },
      { ...hostRepo({ owner: 'other', name: 'sdk' }), pushed_at: 8 },
    ];
    const groups = groupByOwner(repos);
    const added = new Set([repoKey(repo({ name: 'api' }))]);

    expect(selectableRepoKeys(groups, added)).toEqual([
      'github:acme/web',
      'github:other/sdk',
    ]);
  });
});

describe('hostRepoUrl', () => {
  it('builds the host web URL for a host project', () => {
    expect(hostRepoUrl(repo())).toBe('https://github.com/acme/web');
    expect(hostRepoUrl(repo({ host: 'gitlab' }))).toBe(
      'https://gitlab.com/acme/web',
    );
    expect(hostRepoUrl(repo({ host: 'bitbucket' }))).toBe(
      'https://bitbucket.org/acme/web',
    );
  });

  it('is null for a local folder project', () => {
    expect(hostRepoUrl(repo({ host: 'local' }))).toBeNull();
  });
});
