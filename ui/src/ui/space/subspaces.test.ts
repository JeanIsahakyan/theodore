import { describe, expect, it } from 'vitest';
import type { Space } from '../../gen/contract';
import {
  childStage,
  fromLabel,
  mergedIntoParent,
  nestRemoteSubs,
  nestSpaces,
  remoteRoot,
  remoteStage,
  remoteSubRows,
  remoteSubtreeStats,
  spaceRows,
  subSpacesOf,
  subtreeLabel,
  subtreeStats,
  type RemoteSub,
  type RemoteSubRow,
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

  it('puts merged children after the live ones, here and in the tree', () => {
    const merged = { how: 'merged_into_parent', head: 'h' } as Space['shipped'];
    const all = [
      space('a'),
      child('m', 'a', { updated_at: 9, head_sha: 'h', shipped: merged }),
      child('live', 'a', { updated_at: 1 }),
    ];
    expect(subSpacesOf('a', all).map((s) => s.id)).toEqual(['live', 'm']);
    expect(ids(spaceRows(nestSpaces(all), new Set()))).toEqual([
      'a',
      '  live',
      '  m',
    ]);
  });
});

describe("a sub-space's stage", () => {
  const s = (over: Partial<Space>) =>
    space('c', { turns: 1, head_sha: 'h', ...over });
  const merged = { how: 'merged_into_parent', head: 'h' } as Space['shipped'];

  it('starting, running, waiting for you, failed, done, merged', () => {
    expect(childStage(s({ turns: 0 }))).toBe('starting');
    expect(childStage(s({ status: 'running' }))).toBe('running');
    expect(childStage(s({ status: 'running', question: {} as never }))).toBe(
      'asking',
    );
    expect(childStage(s({ status: 'failed' }))).toBe('failed');
    expect(childStage(s({}))).toBe('done');
    expect(childStage(s({ shipped: merged }))).toBe('merged');
    // Merged and archived since: still merged.
    expect(childStage(s({ shipped: merged, status: 'archived' }))).toBe(
      'merged',
    );
    expect(childStage(s({ status: 'archived' }))).toBe('archived');
  });

  it('a turn after the merge is work the parent has not taken', () => {
    expect(mergedIntoParent(s({ shipped: merged, head_sha: 'h2' }))).toBe(
      false,
    );
    expect(childStage(s({ shipped: merged, head_sha: 'h2' }))).toBe('done');
    // Running again after a merge runs.
    expect(childStage(s({ shipped: merged, status: 'running' }))).toBe(
      'running',
    );
  });
});

describe("a mirrored space's sub-spaces on its host", () => {
  const sub = (
    id: string,
    parent: string,
    over: Partial<RemoteSub> = {},
  ): RemoteSub => ({
    id: `rs_1:${id}`,
    root: 'rs_1',
    space: id,
    parent,
    title: id,
    status: 'idle',
    mode: 'edit',
    done: false,
    seq: 1,
    ...over,
  });
  const names = (rows: RemoteSubRow[]) =>
    rows.map((r) => `${'  '.repeat(r.depth)}${r.sub.space}`);

  it('nests under the root and their parents; a lost parent or a loop sits under the root', () => {
    const all = [
      sub('c1', 'rs_1', { seq: 2 }),
      sub('c2', 'c1'),
      sub('c3', 'gone', { seq: 3 }),
      sub('x', 'y'),
      sub('y', 'x'),
      sub('old', 'rs_1', { status: 'archived', seq: 9 }),
      sub('other', 'rs_1', { root: 'rs_2', id: 'rs_2:other' }),
    ];
    const tree = nestRemoteSubs('rs_1', all);
    expect(names(remoteSubRows(tree, new Set(), 1, 'Port it'))).toEqual([
      '  c3',
      '  c1',
      '    c2',
      '  x',
      '  y',
    ]);
    expect(remoteSubtreeStats(tree).total).toBe(5);
  });

  it('puts merged ones last and folds a collapsed parent', () => {
    const tree = nestRemoteSubs('rs_1', [
      sub('m', 'rs_1', { done: true, seq: 9 }),
      sub('live', 'rs_1', { status: 'running', seq: 1 }),
      sub('kid', 'live', { status: 'question' }),
    ]);
    const rows = remoteSubRows(tree, new Set(['rs_1:live']), 1, 'Port it');
    expect(names(rows)).toEqual(['  live', '  m']);
    expect(rows[0]!.stats).toEqual({ total: 1, running: 1, asking: 1 });
    expect(remoteSubtreeStats(tree)).toEqual({
      total: 3,
      running: 2,
      asking: 1,
    });
    const open = remoteSubRows(tree, new Set(), 1, 'Port it');
    expect(open.map((r) => r.parentTitle)).toEqual([
      'Port it',
      'live',
      'Port it',
    ]);
  });

  it('words its stage as a local one', () => {
    const stage = (over: Partial<RemoteSub>) =>
      remoteStage(sub('c', 'rs_1', over));
    expect(stage({ status: 'running' })).toBe('running');
    expect(stage({ status: 'question' })).toBe('asking');
    expect(stage({ status: 'setting_up' })).toBe('starting');
    expect(stage({ status: 'failed', done: true })).toBe('failed');
    expect(stage({ done: true })).toBe('merged');
    expect(stage({})).toBe('done');
    expect(stage({ status: 'archived' })).toBe('archived');
  });

  it('nests only under the mirrored space at the top of its tree', () => {
    const remote = {
      space: 'rs_1',
      host_device: 'd',
      host_name: 'mac',
      project_name: 'app',
      started_here: true,
    };
    expect(remoteRoot({ id: 'rs_1', remote })).toBe(true);
    expect(remoteRoot({ id: 'x', remote })).toBe(false);
    expect(remoteRoot({ id: 'rs_1', remote: null })).toBe(false);
  });
});
