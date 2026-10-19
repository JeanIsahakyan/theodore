import { describe, expect, it } from 'vitest';
import { countByKind, defaultTab, groupByFile } from './display';
import type { SymbolHit } from '../../gen/contract';

function hit(
  path: string,
  line: number,
  kind: SymbolHit['kind'],
  preview = '',
): SymbolHit {
  return { path, line, kind, preview };
}

describe('groupByFile', () => {
  it('groups hits by path, keeping arrival order of both groups and hits', () => {
    const hits = [
      hit('b.rs', 3, 'reference'),
      hit('a.rs', 1, 'definition'),
      hit('b.rs', 7, 'reference'),
      hit('a.rs', 9, 'reference'),
    ];
    const groups = groupByFile(hits);
    expect(groups.map((g) => g.path)).toEqual(['b.rs', 'a.rs']);
    expect(groups[0]!.hits.map((h) => h.line)).toEqual([3, 7]);
    expect(groups[1]!.hits.map((h) => h.line)).toEqual([1, 9]);
  });

  it('returns no groups for an empty list', () => {
    expect(groupByFile([])).toEqual([]);
  });

  it('puts every hit from the same file in one group even if not adjacent', () => {
    const hits = [
      hit('a.rs', 1, 'definition'),
      hit('b.rs', 1, 'definition'),
      hit('a.rs', 2, 'reference'),
    ];
    const groups = groupByFile(hits);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.path === 'a.rs')!.hits).toHaveLength(2);
  });
});

describe('countByKind', () => {
  it('counts definitions and references separately', () => {
    const hits = [
      hit('a.rs', 1, 'definition'),
      hit('b.rs', 1, 'reference'),
      hit('c.rs', 1, 'reference'),
    ];
    expect(countByKind(hits)).toEqual({ definitions: 1, references: 2 });
  });

  it('is all zero for an empty list', () => {
    expect(countByKind([])).toEqual({ definitions: 0, references: 0 });
  });
});

describe('defaultTab', () => {
  it('opens on Definition when find_symbol found one', () => {
    const hits = [hit('a.rs', 1, 'reference'), hit('b.rs', 1, 'definition')];
    expect(defaultTab(hits)).toBe('def');
  });

  it('falls back to References when there is no declaration', () => {
    const hits = [hit('a.rs', 1, 'reference')];
    expect(defaultTab(hits)).toBe('refs');
  });

  it('defaults to References for an empty result (never an empty tab choice that matters)', () => {
    expect(defaultTab([])).toBe('refs');
  });
});
