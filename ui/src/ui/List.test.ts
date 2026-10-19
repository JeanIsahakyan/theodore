import { describe, expect, it } from 'vitest';
import type { RepoRef } from '../gen/contract';
import { prIdFor } from './List';

describe('prIdFor', () => {
  it('builds a github id matching PrRef::id()', () => {
    const repo: RepoRef = { host: 'github', owner: 'acme', name: 'api' };
    expect(prIdFor(repo, 482)).toBe('github:acme/api#482');
  });

  it('builds a gitlab id with a namespaced owner', () => {
    const repo: RepoRef = { host: 'gitlab', owner: 'group/sub', name: 'proj' };
    expect(prIdFor(repo, 3)).toBe('gitlab:group/sub/proj#3');
  });
});
