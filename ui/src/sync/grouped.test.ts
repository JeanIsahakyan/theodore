import { autorun } from 'mobx';
import { describe, expect, it } from 'vitest';
import { ObjectPool } from './ObjectPool';
import { modelAccessors } from './models';
import { groupKey } from './grouped';

const anchor = (path: string, line: number) => ({
  rev: 'h',
  path,
  side: 'new' as const,
  line,
  start_line: null,
  start_side: null,
});

const finding = (id: string, pr: string, path: string, line: number) => ({
  id,
  pr,
  skill: 's',
  agents: [],
  anchor: anchor(path, line),
  severity: 'warn',
  title: id,
  body: '',
  state: 'open',
  fix: null,
});

describe('grouped indexes', () => {
  it('byPr matches where(pr) and keeps pool order', () => {
    const pool = new ObjectPool();
    const m = modelAccessors(pool);
    pool.put('hunk_read', 'a:1', { pr: 'a', hunk: '1' });
    pool.put('hunk_read', 'b:1', { pr: 'b', hunk: '1' });
    pool.put('hunk_read', 'a:2', { pr: 'a', hunk: '2' });
    expect(m.hunkReads.byPr('a')).toEqual(
      m.hunkReads.where((r) => r.pr === 'a'),
    );
    expect(m.hunkReads.isRead('a', '2')).toBe(true);
    expect(m.hunkReads.isRead('b', '2')).toBe(false);
    pool.remove('hunk_read', 'a:2');
    expect(m.hunkReads.isRead('a', '2')).toBe(false);
  });

  it('re-runs an observer only when its own key changes', () => {
    const pool = new ObjectPool();
    const m = modelAccessors(pool);
    pool.put('finding', 'f1', finding('f1', 'p', 'a.ts', 1));
    const seen: number[] = [];
    const stop = autorun(() => {
      seen.push(m.findings.shownAt('p', 'a.ts', 'new', 1).length);
    });
    pool.put('finding', 'f2', finding('f2', 'p', 'a.ts', 2));
    pool.put('finding', 'f3', finding('f3', 'q', 'a.ts', 1));
    expect(seen).toEqual([1]);
    pool.put('finding', 'f4', finding('f4', 'p', 'a.ts', 1));
    expect(seen).toEqual([1, 2]);
    pool.merge('finding', 'f4', { state: 'ignored' });
    expect(seen).toEqual([1, 2, 1]);
    stop();
  });

  it('keeps a slice reference stable while its rows are unchanged', () => {
    const pool = new ObjectPool();
    const m = modelAccessors(pool);
    pool.put('draft', 'd1', {
      id: 'd1',
      pr: 'p',
      anchor: anchor('a.ts', 3),
      body: 'x',
      source: 'human',
    });
    const refs: unknown[] = [];
    const stop = autorun(() => refs.push(m.drafts.at('p', 'a.ts', 'new', 3)));
    pool.put('draft', 'd2', {
      id: 'd2',
      pr: 'p',
      anchor: anchor('a.ts', 9),
      body: 'y',
      source: 'human',
    });
    expect(refs).toHaveLength(1);
    stop();
  });

  it('fileViews.of is the last row for the path', () => {
    const pool = new ObjectPool();
    const m = modelAccessors(pool);
    pool.put('file_viewed', 'p:a', { pr: 'p', path: 'a', state: 'viewed' });
    expect(m.fileViews.of('p', 'a')?.state).toBe('viewed');
    expect(m.fileViews.of('p', 'b')).toBeUndefined();
  });

  it('indexes thread ids by anchor', () => {
    const pool = new ObjectPool();
    const m = modelAccessors(pool);
    pool.put('pr_detail', 'p', {
      threads: [
        { id: 't1', anchor: anchor('a.ts', 4), resolved: false },
        { id: 't2', anchor: null, resolved: false },
      ],
    });
    expect(m.threadIdsAt('p', 'a.ts', 'new', 4)).toEqual(['t1']);
    expect(m.threadIdsAt('p', 'a.ts', 'new', 5)).toEqual([]);
  });

  it('groupKey keeps parts apart', () => {
    expect(groupKey('a', 'b')).not.toBe(groupKey('ab'));
  });
});
