import { describe, expect, it } from 'vitest';
import type { FileDiff, Group, Hunk, Revision } from '../../gen/contract';
import {
  diffFiles,
  hunkAt,
  hunksInScope,
  jumpView,
  moveHunkFocus,
  type DiffFilters,
} from './hunks';

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

const ALL: DiffFilters = { since: null, allEdits: false, hiddenShown: false };
const ids = (hs: { id: string }[]) => hs.map((h) => h.id);
const GROUPS = { mode: 'groups', group: 'g1', file: null } as const;
const group = (
  hunks: string[],
  outliers: string[] = [],
  kind: Group['kind'] = outliers.length ? 'skim' : 'normal',
) => ({ hunks, outliers, kind });

const rev: Pick<Revision, 'files'> = {
  files: [file('a.ts', [hunk('h1'), hunk('h2')]), file('b.ts', [hunk('h3')])],
};

describe('hunksInScope', () => {
  it('returns only the selected file in files mode', () => {
    expect(
      ids(
        hunksInScope(
          rev,
          { mode: 'files', group: null, file: 'b.ts' },
          null,
          ALL,
        ),
      ),
    ).toEqual(['h3']);
  });

  it('returns nothing when the selected file has no match', () => {
    expect(
      hunksInScope(
        rev,
        { mode: 'files', group: null, file: 'z.ts' },
        null,
        ALL,
      ),
    ).toEqual([]);
  });

  it('filters to the group when a group is given', () => {
    const got = hunksInScope(rev, GROUPS, group(['h2', 'h3']), ALL);
    expect(ids(got)).toEqual(['h2', 'h3']);
  });

  it('falls back to every hunk when there is no group filter', () => {
    const got = hunksInScope(
      rev,
      { mode: 'groups', group: null, file: null },
      null,
      ALL,
    );
    expect(ids(got)).toEqual(['h1', 'h2', 'h3']);
  });

  // a.ts [a1 a2], b.ts [b1]; the group reads a1 b1 a2.
  const ab: Pick<Revision, 'files'> = {
    files: [file('a.ts', [hunk('a1'), hunk('a2')]), file('b.ts', [hunk('b1')])],
  };

  it('with "Since only", steps through the shown hunks in the shown order', () => {
    const filters = { ...ALL, since: new Set(['b1', 'a2']) };
    const g = group(['a1', 'b1', 'a2']);
    // b.ts first: its b1 comes before a.ts's first changed hunk, a2; a1
    // isn't shown at all.
    expect(ids(hunksInScope(ab, GROUPS, g, filters))).toEqual(['b1', 'a2']);
    expect(diffFiles(ab, GROUPS, g, filters).map((f) => f.path)).toEqual([
      'b.ts',
      'a.ts',
    ]);
  });

  it('with "Since only" in files mode, skips the unchanged hunks', () => {
    const filters = { ...ALL, since: new Set(['a2']) };
    const mode = { mode: 'files', group: null, file: 'a.ts' } as const;
    expect(ids(hunksInScope(ab, mode, null, filters))).toEqual(['a2']);
  });

  it('steps through only the outliers of a skim group until "Show all"', () => {
    const g = group(['b1', 'a1', 'a2'], ['a2']);
    expect(ids(hunksInScope(ab, GROUPS, g, ALL))).toEqual(['a2']);
    expect(
      ids(hunksInScope(ab, GROUPS, g, { ...ALL, allEdits: true })),
    ).toEqual(['a1', 'a2', 'b1']);
  });

  it('combines "Only outliers" with "Since only"', () => {
    const g = group(['a1', 'b1', 'a2'], ['a1', 'b1']);
    const filters = { ...ALL, since: new Set(['b1', 'a2']) };
    expect(ids(hunksInScope(ab, GROUPS, g, filters))).toEqual(['b1']);
  });

  it('steps through nothing of a collapsed hidden group until "Show anyway"', () => {
    const g = group(['a1', 'b1'], [], 'hidden');
    expect(hunksInScope(ab, GROUPS, g, ALL)).toEqual([]);
    expect(
      ids(hunksInScope(ab, GROUPS, g, { ...ALL, hiddenShown: true })),
    ).toEqual(['a1', 'b1']);
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

describe('hunkAt', () => {
  const at = (id: string, o: number, ol: number, n: number, nl: number) => ({
    ...hunk(id),
    old_start: o,
    old_lines: ol,
    new_start: n,
    new_lines: nl,
  });
  const r = {
    files: [file('a.ts', [at('h1', 1, 5, 1, 5), at('h2', 8, 4, 10, 5)])],
  };
  const go = (side: 'old' | 'new', line: number, path = 'a.ts') =>
    hunkAt(r, { path, side, line })?.hunk.id ?? null;

  it('finds the hunk holding the line on its side', () => {
    expect(go('new', 12)).toBe('h2');
    expect(go('old', 9)).toBe('h2');
    expect(go('new', 3)).toBe('h1');
  });

  it('a line between hunks lands on the next one, past them on the last', () => {
    expect(go('new', 7)).toBe('h2');
    expect(go('new', 40)).toBe('h2');
  });

  it('nothing for a file not in the diff', () => {
    expect(go('new', 1, 'z.ts')).toBeNull();
  });
});

describe('jumpView', () => {
  const groups = [
    { id: 'g1', ...group(['h1']) },
    { id: 'g2', ...group(['h2', 'h3'], ['h3']) },
    { id: 'g3', ...group(['h9'], [], 'hidden') },
  ];
  const plain = () => ALL;
  const g1 = { mode: 'groups', group: 'g1', file: null } as const;

  it('keeps the view that already shows the hunk', () => {
    const v = jumpView(rev, g1, groups, plain, 'a.ts', 'h1');
    expect(v.mode).toBe(g1);
    expect([v.sinceOff, v.showAll, v.showHidden]).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('opens the group holding it, past "Only outliers"', () => {
    const v = jumpView(rev, g1, groups, plain, 'a.ts', 'h2');
    expect(v.mode).toEqual({ mode: 'groups', group: 'g2', file: 'a.ts' });
    expect(v.showAll).toBe(true);
  });

  it('turns "Since only" off when it hides the hunk', () => {
    const since = () => ({ ...ALL, since: new Set(['h3']) });
    const v = jumpView(rev, g1, groups, since, 'a.ts', 'h2');
    expect(v.sinceOff).toBe(true);
  });

  it('in files mode, opens the file', () => {
    const files = { mode: 'files', group: 'g1', file: 'b.ts' } as const;
    const v = jumpView(rev, files, groups, plain, 'a.ts', 'h1');
    expect(v.mode).toEqual({ mode: 'files', group: 'g1', file: 'a.ts' });
  });

  it('shows a hidden group anyway', () => {
    const r = { files: [...rev.files, file('c.ts', [hunk('h9')])] };
    const v = jumpView(r, g1, groups, plain, 'c.ts', 'h9');
    expect(v.mode.group).toBe('g3');
    expect(v.showHidden).toBe(true);
  });
});
