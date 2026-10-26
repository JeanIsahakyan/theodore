import { describe, expect, it } from 'vitest';
import type { FileDiff, Hunk, Revision } from '../../gen/contract';
import { hunksInScope, moveHunkFocus } from './hunks';

const hunk = (id: string): Hunk => ({
  id,
  path: 'a.ts',
  old_start: 1,
  old_lines: 0,
  new_start: 1,
  new_lines: 0,
  header: '',
  lines: [],
});

const file = (path: string, hunks: Hunk[]): FileDiff => ({
  path,
  old_path: null,
  status: 'modified',
  similarity: null,
  old_mode: null,
  new_mode: null,
  flags: [],
  additions: 0,
  deletions: 0,
  hunks,
});

const rev: Pick<Revision, 'files'> = {
  files: [file('a.ts', [hunk('h1'), hunk('h2')]), file('b.ts', [hunk('h3')])],
};

describe('hunksInScope', () => {
  it('returns only the selected file in files mode', () => {
    expect(
      hunksInScope(rev, { mode: 'files', group: null, file: 'b.ts' }, null).map(
        (h) => h.id,
      ),
    ).toEqual(['h3']);
  });

  it('returns nothing when the selected file has no match', () => {
    expect(
      hunksInScope(rev, { mode: 'files', group: null, file: 'z.ts' }, null),
    ).toEqual([]);
  });

  it('filters to the group when a group-hunk set is given', () => {
    const got = hunksInScope(
      rev,
      { mode: 'groups', group: 'g1', file: null },
      new Set(['h2', 'h3']),
    );
    expect(got.map((h) => h.id)).toEqual(['h2', 'h3']);
  });

  it('falls back to every hunk when there is no group filter', () => {
    const got = hunksInScope(
      rev,
      { mode: 'groups', group: null, file: null },
      null,
    );
    expect(got.map((h) => h.id)).toEqual(['h1', 'h2', 'h3']);
  });
});

describe('moveHunkFocus', () => {
  const hunks = [{ id: 'h1' }, { id: 'h2' }, { id: 'h3' }];

  it('moves to the first hunk from no focus, either direction', () => {
    expect(moveHunkFocus(hunks, null, 1)).toBe('h1');
    expect(moveHunkFocus(hunks, null, -1)).toBe('h1');
  });

  it('steps forward and backward', () => {
    expect(moveHunkFocus(hunks, 'h1', 1)).toBe('h2');
    expect(moveHunkFocus(hunks, 'h2', -1)).toBe('h1');
  });

  it('clamps at the last hunk', () => {
    expect(moveHunkFocus(hunks, 'h3', 1)).toBe('h3');
  });

  it('clamps at the first hunk', () => {
    expect(moveHunkFocus(hunks, 'h1', -1)).toBe('h1');
  });

  it('returns null for an empty scope', () => {
    expect(moveHunkFocus([], 'h1', 1)).toBeNull();
  });
});
