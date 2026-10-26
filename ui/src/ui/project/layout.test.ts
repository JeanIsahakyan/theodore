import { describe, expect, it } from 'vitest';
import type { RepoRef } from '../../gen/contract';
import { isLocalFolder, workingStateParts } from './layout';

const local: RepoRef = { host: 'local', owner: 'local', name: 'web' };
const github: RepoRef = { host: 'github', owner: 'acme', name: 'web' };

describe('isLocalFolder', () => {
  it('is a local repo with a folder path', () => {
    expect(isLocalFolder({ repo: local, path: '/src/web' })).toBe(true);
    expect(isLocalFolder({ repo: github, path: null })).toBe(false);
    expect(isLocalFolder({ repo: local, path: null })).toBe(false);
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
