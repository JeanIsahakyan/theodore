import { describe, expect, it } from 'vitest';
import type { Space } from '../../gen/contract';
import {
  fromLabel,
  nestSpaces,
  spaceRows,
  subSpacesOf,
  subtreeLabel,
  subtreeStats,
} from './subspaces';

const space = (id: string, over: Partial<Space> = {}): Space =>
  ({
    id,
    project: 'local:app',
    name: id,
    goal: id,
    status: 'idle',
    updated_at: 0,
    ...over,
  }) as Space;

const child = (id: string, parent: string, over: Partial<Space> = {}) =>
  space(id, { parent: { space: parent, depth: 1 }, ...over });

const ids = (rows: { space: Space; depth: number }[]) =>
  rows.map((r) => `${'  '.repeat(r.depth)}${r.space.id}`);

describe('sub-spaces as a tree', () => {
  it('puts a child under its parent, in the list order, not at the top', () => {
    const listed = [
      space('b'),
      child('a1', 'a'),
      space('a'),
      child('a2', 'a'),
      child('a1x', 'a1', { parent: { space: 'a1', depth: 2 } }),
    ];
    expect(ids(spaceRows(nestSpaces(listed), new Set()))).toEqual([
      'b',
      'a',
      '  a1',
      '    a1x',
      '  a2',
    ]);
  });

  it('hides what a collapsed parent holds, and counts it', () => {
    const listed = [
      space('a'),
      child('a1', 'a', { status: 'running' }),
      child('a2', 'a', { status: 'running', question: {} as never }),
    ];
    const rows = spaceRows(nestSpaces(listed), new Set(['a']));
    expect(ids(rows)).toEqual(['a']);
    expect(rows[0]!.collapsed).toBe(true);
    expect(rows[0]!.stats).toEqual({ total: 2, running: 2, asking: 1 });
    expect(subtreeLabel(rows[0]!.stats!)).toBe(
      '2 sub-spaces, 2 running, 1 waiting for you',
    );
    // A row with no children has nothing to collapse.
    const open = spaceRows(nestSpaces(listed), new Set(['a1']));
    expect(open.find((r) => r.space.id === 'a1')!.stats).toBeNull();
    expect(open.find((r) => r.space.id === 'a1')!.collapsed).toBe(false);
  });

  it('shows a child of an unlisted parent at the top, naming it', () => {
    const parent = space('p', { status: 'archived', title: 'Old work' });
    const orphan = child('c', 'p');
    const gone = child('g', 'nowhere');
    const rows = spaceRows(nestSpaces([orphan, gone]), new Set(), [
      parent,
      orphan,
      gone,
    ]);
    expect(rows.map((r) => [r.space.id, r.depth, r.from])).toEqual([
      ['c', 0, 'from Old work'],
      ['g', 0, 'from a removed space'],
    ]);
  });

  it("doesn't name a mirrored space's parent: it is its host's", () => {
    expect(
      fromLabel({ parent: { space: 'x', depth: 1 }, remote: {} as never }, []),
    ).toBeNull();
    expect(fromLabel({ parent: null }, [])).toBeNull();
  });

  it('never nests a loop', () => {
    const a = child('a', 'b');
    const b = child('b', 'a');
    const self = child('s', 's');
    const rows = spaceRows(nestSpaces([a, b, self]), new Set());
    expect(ids(rows)).toEqual(['a', 'b', 's']);
  });

  it('counts the whole subtree', () => {
    const [root] = nestSpaces([
      space('a'),
      child('a1', 'a'),
      child('a2', 'a1', { status: 'running' }),
    ]);
    expect(subtreeStats(root!)).toEqual({ total: 2, running: 1, asking: 0 });
    expect(subtreeLabel({ total: 1, running: 0, asking: 0 })).toBe(
      '1 sub-space',
    );
  });

  it("lists a space's own sub-spaces, newest first, archived aside", () => {
    const all = [
      child('old', 'a', { updated_at: 1 }),
      child('new', 'a', { updated_at: 5 }),
      child('gone', 'a', { status: 'archived', updated_at: 9 }),
      child('other', 'b'),
    ];
    expect(subSpacesOf('a', all).map((s) => s.id)).toEqual(['new', 'old']);
  });
});
