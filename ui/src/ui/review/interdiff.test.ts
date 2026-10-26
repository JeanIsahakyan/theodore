import { describe, expect, it } from 'vitest';
import type { InterdiffEntry } from '../../gen/contract';
import { interdiffByHunk, interdiffView } from './interdiff';

const entry = (
  over: Partial<InterdiffEntry> & { hunk: string },
): InterdiffEntry => ({
  path: 'a.ts',
  class: 'changed',
  previous: null,
  words: [],
  ...over,
});

describe('interdiffByHunk', () => {
  it('keys by each entry hunk id', () => {
    const map = interdiffByHunk([entry({ hunk: 'h1' }), entry({ hunk: 'h2' })]);
    expect([...map.keys()]).toEqual(['h1', 'h2']);
  });

  it('is empty for an empty response', () => {
    expect(interdiffByHunk([]).size).toBe(0);
  });
});

describe('interdiffView', () => {
  it('is null when there is no entry for the hunk', () => {
    expect(interdiffView(undefined)).toBeNull();
  });

  it('is null for a class other than changed', () => {
    expect(
      interdiffView(entry({ hunk: 'h1', class: 'new', words: [] })),
    ).toBeNull();
    expect(
      interdiffView(entry({ hunk: 'h1', class: 'unchanged', words: [] })),
    ).toBeNull();
    expect(
      interdiffView(entry({ hunk: 'h1', class: 'vanished', words: [] })),
    ).toBeNull();
  });

  it('is null for a changed hunk with no word-diff', () => {
    expect(
      interdiffView(entry({ hunk: 'h1', class: 'changed', words: [] })),
    ).toBeNull();
  });

  it('builds previous/now lines for a changed hunk with words', () => {
    const view = interdiffView(
      entry({
        hunk: 'h1',
        class: 'changed',
        previous: 'old1',
        words: [
          { kind: 'del', text: '1' },
          { kind: 'add', text: '2' },
        ],
      }),
    );
    expect(view).toEqual({
      previous: [{ text: '1', marks: [[0, 1]] }],
      now: [{ text: '2', marks: [[0, 1]] }],
    });
  });
});
