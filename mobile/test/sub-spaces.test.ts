import { describe, expect, it } from 'vitest';
import type { MirroredSubSpace } from '../src/gen/fleet';
import {
  subSpaceCounts,
  subSpaceRows,
  subSpaceState,
  subSpaceSummary,
} from '../src/ui/subSpaceTree';

const ROOT = 'rs_root';

const sub = (
  space: string,
  parent = ROOT,
  over: Partial<MirroredSubSpace> = {},
): MirroredSubSpace => ({
  space,
  parent,
  title: space,
  status: 'running',
  mode: 'edit',
  done: false,
  ...over,
});

const byId = (...list: MirroredSubSpace[]) =>
  Object.fromEntries(list.map((s) => [s.space, s]));

/** The rows as an indented outline. */
const shape = (subs: Record<string, MirroredSubSpace>) =>
  subSpaceRows(ROOT, subs).map((r) => `${'  '.repeat(r.depth)}${r.sub.space}`);

describe('subSpaceState', () => {
  it("reads the host's words, done first", () => {
    const state = (status: string, done = false) =>
      subSpaceState({ status, done });
    expect(state('running')).toBe('running');
    expect(state('setting_up')).toBe('running');
    expect(state('question')).toBe('waiting');
    expect(state('waiting')).toBe('waiting');
    expect(state('failed')).toBe('failed');
    expect(state('idle')).toBe('done');
    expect(state('archived')).toBe('done');
    expect(state('what')).toBe('done');
    expect(state('running', true)).toBe('merged');
  });
});

describe('subSpaceRows', () => {
  it('puts children under their parent, siblings in the order first seen', () => {
    const subs = byId(
      sub('b'),
      sub('a1', 'a'),
      sub('a'),
      sub('b1', 'b'),
      sub('a2', 'a'),
    );
    expect(shape(subs)).toEqual(['b', '  b1', 'a', '  a1', '  a2']);
  });

  it('shows rows whose parent is missing at the top, after the tree', () => {
    const subs = byId(sub('lost', 'gone'), sub('lost1', 'lost'), sub('a'));
    expect(shape(subs)).toEqual(['a', 'lost', '  lost1']);
  });

  it('cuts a loop of parents instead of hiding or repeating it', () => {
    const rows = shape(byId(sub('x', 'y'), sub('y', 'x'), sub('a')));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe('a');
    expect(rows.map((r) => r.trim()).sort()).toEqual(['a', 'x', 'y']);
  });

  it('carries each row its state', () => {
    const rows = subSpaceRows(
      ROOT,
      byId(
        sub('a', ROOT, { done: true }),
        sub('b', ROOT, { status: 'question' }),
      ),
    );
    expect(rows.map((r) => r.state)).toEqual(['merged', 'waiting']);
  });

  it('is empty with none', () => {
    expect(subSpaceRows(ROOT, {})).toEqual([]);
  });
});

describe('subSpaceSummary', () => {
  it('counts every level, running and waiting apart', () => {
    const subs = byId(
      sub('a'),
      sub('a1', 'a', { status: 'idle', done: true }),
      sub('b', ROOT, { status: 'question' }),
      sub('c', ROOT, { status: 'setting_up' }),
      sub('d', ROOT, { status: 'failed' }),
    );
    expect(subSpaceCounts(subs)).toEqual({ total: 5, running: 2, waiting: 1 });
    expect(subSpaceSummary(subs)).toBe('5 sub-spaces, 2 running, 1 waiting');
  });

  it('says only what there is', () => {
    expect(subSpaceSummary(undefined)).toBeNull();
    expect(subSpaceSummary({})).toBeNull();
    expect(subSpaceSummary(byId(sub('a', ROOT, { status: 'idle' })))).toBe(
      '1 sub-space',
    );
    expect(subSpaceSummary(byId(sub('a'), sub('b'), sub('c', 'a')))).toBe(
      '3 sub-spaces, 3 running',
    );
  });
});
