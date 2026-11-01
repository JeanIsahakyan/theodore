/** A hunk's header hint (its function name) is redundant once the gap right
 *  above it is fully revealed — "Load N lines of context" then "all" makes
 *  the code visible, so repeating it on the hunk header is noise (#52). A
 *  partial reveal (just "20 more") keeps the hint: the gap above the hunk
 *  isn't fully shown yet. */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setTransport } from '../core/transport';
import { FakeTransport } from '../test/fakeTransport';
import { mountBigPr } from '../test/bigPr';

describe('context gap and the hunk header hint', () => {
  let view: Awaited<ReturnType<typeof mountBigPr>>;

  beforeEach(async () => {
    const transport = new FakeTransport();
    // 200 lines is plenty for the gap above `f0h1` (new lines 13..60).
    transport.queueResult(
      'get_file',
      Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n'),
    );
    setTransport(transport);
    view = await mountBigPr();
  });

  afterEach(() => view.unmount());

  const hunkWrap = () => view.host.querySelector('#H-f0h1')!.parentElement!;
  const headerHint = () =>
    [...view.host.querySelectorAll('#H-f0h1 span')].find(
      (el) => el.textContent === 'function f0()',
    ) ?? null;

  it('keeps the hint for a partial reveal, drops it once fully revealed', async () => {
    expect(headerHint()).not.toBeNull();

    // First click: "Load 48 lines of context" reveals only the first
    // STEP (20) of the gap's 48 lines — a partial reveal.
    const loadBtn = hunkWrap().querySelector<HTMLButtonElement>('.gap button')!;
    expect(loadBtn.textContent).toContain('Load 48 lines of context');
    await act(async () => loadBtn.click());
    expect(headerHint()).not.toBeNull();

    // "all 28" reveals the rest of the gap — now fully shown.
    const allBtn = hunkWrap().querySelector<HTMLButtonElement>('.expand-all')!;
    expect(allBtn.textContent).toContain('all 28');
    await act(async () => allBtn.click());
    expect(headerHint()).toBeNull();
  });
});
