/**
 * Render-count budget for the diff on a big PR (~100 files, ~3000 lines,
 * ~50 findings; see `test/bigPr.tsx`). Counts come from `core/perf.ts`;
 * each case asserts that one small change re-renders only what it touches.
 *
 * jsdom has no IntersectionObserver, so every file in the 40-file chunk is
 * mounted here (1200 lines) — the worst case for re-renders.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderCounts } from '../core/perf';
import { PR, mountBigPr, newLine, putFinding } from '../test/bigPr';

type Counts = { Line: number; Hunk: number; FileBlock: number };
const snapshot = (): Counts => ({
  Line: renderCounts.get('Line'),
  Hunk: renderCounts.get('Hunk'),
  FileBlock: renderCounts.get('FileBlock'),
});

async function measure(fn: () => void): Promise<Counts> {
  renderCounts.reset();
  await act(async () => fn());
  return snapshot();
}

describe('DiffPane render budget on a big PR', () => {
  let view: Awaited<ReturnType<typeof mountBigPr>>;
  let mounted: Counts;

  beforeEach(async () => {
    renderCounts.reset();
    view = await mountBigPr();
    mounted = snapshot();
  });

  afterEach(() => view.unmount());

  it('mounts each line once', () => {
    expect(mounted).toEqual({ Line: 1200, Hunk: 80, FileBlock: 40 });
  });

  it('(a) one hunk_read re-renders one hunk and no lines', async () => {
    const c = await measure(() =>
      view.store.sync.pool.put('hunk_read', `${PR}:f3h0`, {
        pr: PR,
        hunk: 'f3h0',
      }),
    );
    expect(c).toEqual({ Line: 0, Hunk: 1, FileBlock: 0 });
    expect(view.host.querySelector('#H-f3h0')?.className).toContain('read');
  });

  it('(b) one finding re-renders one line', async () => {
    const c = await measure(() =>
      putFinding(view.store, view.rev, 'new', 5, 4),
    );
    expect(c).toEqual({ Line: 1, Hunk: 1, FileBlock: 0 });
    expect(
      view.host.querySelector('#H-f5h0 [title="finding new"]'),
    ).not.toBeNull();
  });

  it('(c) moving hunk focus re-renders only the hunks involved', async () => {
    const first = await measure(() => view.controls().setFocus('f2h1'));
    expect(first).toEqual({ Line: 0, Hunk: 1, FileBlock: 1 });
    const next = await measure(() => view.controls().setFocus('f4h0'));
    expect(next).toEqual({ Line: 0, Hunk: 2, FileBlock: 2 });
    expect(view.host.querySelector('#H-f4h0')?.className).toContain('focus');
    expect(view.host.querySelector('#H-f2h1')?.className).not.toContain(
      'focus',
    );
  });

  it('opening a composer re-renders one line and shows one composer', async () => {
    const c = await measure(() =>
      view.controls().setComposer({
        path: view.rev.files[1]!.path,
        side: 'new',
        line: newLine(view.rev, 1, 2),
      }),
    );
    expect(c).toEqual({ Line: 1, Hunk: 1, FileBlock: 1 });
    expect(view.host.querySelectorAll('.composer')).toHaveLength(1);
  });
});
