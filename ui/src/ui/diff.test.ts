import { describe, expect, it } from 'vitest';
import type { DiffLine, FileDiff, Hunk } from '../gen/contract';
import {
  gapTail,
  gapsAbove,
  sinceCountsFor,
  sinceHunks,
  splitRows,
  wordMarks,
} from './diff';

const line = (
  kind: DiffLine['kind'],
  text: string,
  old_no: number | null = null,
  new_no: number | null = null,
): DiffLine => ({ kind, text, old_no, new_no });

const hunk = (
  over: Partial<Hunk> & { id: string; lines: DiffLine[] },
): Hunk => ({
  path: 'a.ts',
  old_start: 1,
  old_lines: 0,
  new_start: 1,
  new_lines: 0,
  header: '',
  ...over,
});

describe('wordMarks', () => {
  it('marks the changed word between a paired del/add line', () => {
    const lines = [line('del', 'const x = 1;'), line('add', 'const x = 2;')];
    const marks = wordMarks(lines);
    expect(marks.get(0)).toEqual([[10, 11]]);
    expect(marks.get(1)).toEqual([[10, 11]]);
  });

  it('pairs runs of equal length del/add lines index by index', () => {
    const lines = [
      line('del', 'foo(1)'),
      line('del', 'bar(1)'),
      line('add', 'foo(2)'),
      line('add', 'bar(2)'),
    ];
    const marks = wordMarks(lines);
    expect(marks.get(0)).toEqual([[4, 5]]);
    expect(marks.get(1)).toEqual([[4, 5]]);
    expect(marks.get(2)).toEqual([[4, 5]]);
    expect(marks.get(3)).toEqual([[4, 5]]);
  });

  it('skips a pair whose lines are too different to usefully mark', () => {
    const lines = [
      line('del', 'const x = 1;'),
      line('add', 'totally different stuff here'),
    ];
    const marks = wordMarks(lines);
    expect(marks.size).toBe(0);
  });

  it('ignores context lines', () => {
    const lines = [line('ctx', 'unchanged')];
    expect(wordMarks(lines).size).toBe(0);
  });
});

describe('splitRows', () => {
  it('puts a context line on both sides of the same row', () => {
    const rows = splitRows([line('ctx', 'same')]);
    expect(rows).toEqual([{ l: 0, r: 0 }]);
  });

  it('zips an equal-length del/add run onto one row each', () => {
    const rows = splitRows([line('del', 'a'), line('add', 'b')]);
    expect(rows).toEqual([{ l: 0, r: 1 }]);
  });

  it('leaves the longer side dangling when del/add counts differ', () => {
    const rows = splitRows([
      line('del', 'a'),
      line('del', 'b'),
      line('add', 'c'),
    ]);
    expect(rows).toEqual([
      { l: 0, r: 2 },
      { l: 1, r: undefined },
    ]);
  });
});

describe('gapsAbove / gapTail', () => {
  it('reports a gap from the top of the file to the first hunk', () => {
    const h = hunk({
      id: 'h1',
      new_start: 10,
      new_lines: 3,
      old_start: 8,
      lines: [],
    });
    const gaps = gapsAbove([h]);
    expect(gaps.get('h1')).toEqual({ from: 1, to: 9, shift: 2 });
  });

  it('reports no gap when a hunk starts at line 1', () => {
    const h = hunk({ id: 'h1', new_start: 1, new_lines: 3, lines: [] });
    expect(gapsAbove([h]).has('h1')).toBe(false);
  });

  it('reports the gap between two hunks', () => {
    const h1 = hunk({ id: 'h1', new_start: 1, new_lines: 2, lines: [] });
    const h2 = hunk({ id: 'h2', new_start: 10, new_lines: 2, lines: [] });
    const gaps = gapsAbove([h1, h2]);
    expect(gaps.has('h1')).toBe(false);
    expect(gaps.get('h2')).toEqual({ from: 3, to: 9, shift: 9 });
  });

  it('reports the tail gap against a known file length', () => {
    const h = hunk({
      id: 'h1',
      new_start: 1,
      new_lines: 5,
      old_start: 1,
      old_lines: 5,
      lines: [],
    });
    expect(gapTail([h], 20)).toEqual({ from: 6, to: 20, shift: 0 });
    expect(gapTail([h], 5)).toBeNull();
  });
});

describe('sinceHunks', () => {
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

  it('marks a hunk in a brand-new file as new', () => {
    const h = hunk({ id: 'h1', new_start: 1, new_lines: 1, lines: [] });
    const since = sinceHunks([], [file('new.ts', [h])]);
    expect(since.get('h1')).toBe('new');
  });

  it('marks a hunk with no overlapping old hunk as new', () => {
    const oldH = hunk({ id: 'o1', new_start: 1, new_lines: 2, lines: [] });
    const newH = hunk({ id: 'n1', new_start: 50, new_lines: 2, lines: [] });
    const since = sinceHunks([file('a.ts', [oldH])], [file('a.ts', [newH])]);
    expect(since.get('n1')).toBe('new');
  });

  it('marks an overlapping hunk with different content as changed', () => {
    const oldH = hunk({
      id: 'o1',
      new_start: 1,
      new_lines: 1,
      lines: [line('add', 'old text')],
    });
    const newH = hunk({
      id: 'n1',
      new_start: 1,
      new_lines: 1,
      lines: [line('add', 'new text')],
    });
    const since = sinceHunks([file('a.ts', [oldH])], [file('a.ts', [newH])]);
    expect(since.get('n1')).toBe('changed');
  });

  it('leaves an unchanged overlapping hunk out of the map', () => {
    const lines = [line('add', 'same text')];
    const oldH = hunk({ id: 'o1', new_start: 1, new_lines: 1, lines });
    const newH = hunk({ id: 'n1', new_start: 1, new_lines: 1, lines });
    const since = sinceHunks([file('a.ts', [oldH])], [file('a.ts', [newH])]);
    expect(since.has('n1')).toBe(false);
  });
});

describe('sinceCountsFor', () => {
  const since = new Map([
    ['h1', 'new' as const],
    ['h2', 'changed' as const],
    ['h3', 'new' as const],
  ]);

  it('counts new and changed separately, among just the given hunks', () => {
    expect(sinceCountsFor([{ id: 'h1' }, { id: 'h2' }], since)).toEqual({
      new: 1,
      changed: 1,
    });
  });

  it('ignores hunks with no entry in the map', () => {
    expect(sinceCountsFor([{ id: 'h4' }], since)).toEqual({
      new: 0,
      changed: 0,
    });
  });

  it('is all-zero without a baseline', () => {
    expect(sinceCountsFor([{ id: 'h1' }], null)).toEqual({
      new: 0,
      changed: 0,
    });
  });
});
