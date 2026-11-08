import { describe, expect, it } from 'vitest';
import type { RepoRef } from '../gen/contract';
import { PEEK_FITS_FROM, peekFits, prIdFor, rowColumns } from './List';

describe('rowColumns', () => {
  it('gives the number column room for the repo name in front of it', () => {
    // 72px cut "tamagochi" to "tamagoc…".
    expect(rowColumns(['id'], true).split(' ')[2]).toBe('160px');
    expect(rowColumns(['id'], false).split(' ')[2]).toBe('72px');
  });
});

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

describe('peekFits', () => {
  it('hides Peek when the list would get squeezed', () => {
    // 900px window minus the 256px sidebar: no room for both.
    expect(peekFits(900 - 256)).toBe(false);
    expect(peekFits(PEEK_FITS_FROM - 1)).toBe(false);
    expect(peekFits(PEEK_FITS_FROM)).toBe(true);
    expect(peekFits(1400 - 256)).toBe(true);
  });
});
