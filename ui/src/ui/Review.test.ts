import { describe, expect, it } from 'vitest';
import { DIFF_MIN, layoutFor, lineIn } from './Review';

describe('layoutFor', () => {
  it('keeps both panes as columns when there is room for all three', () => {
    expect(layoutFor(1600)).toEqual({
      groups: 'column',
      aside: 'column',
      header: 'full',
    });
  });

  it('drops the aside to a drawer first as width shrinks', () => {
    expect(layoutFor(1200)).toEqual({
      groups: 'column',
      aside: 'drawer',
      header: 'full',
    });
  });

  it('drops the groups pane to a drawer too once narrower still', () => {
    expect(layoutFor(1000)).toEqual({
      groups: 'drawer',
      aside: 'drawer',
      header: 'full',
    });
  });

  it('is stable at the minimum supported window width', () => {
    // 900×600 minimum, minus a ~256px sidebar still leaves room for the
    // diff's own floor — both panes collapse, nothing is forced negative.
    const layout = layoutFor(900 - 256);
    expect(layout).toEqual({
      groups: 'drawer',
      aside: 'drawer',
      header: 'compact',
    });
    expect(DIFF_MIN).toBeLessThanOrEqual(900 - 256);
  });

  it('is monotonic: once a pane drops to a drawer, it never comes back as width keeps shrinking', () => {
    for (let w = 1600; w > 300; w -= 37) {
      const wide = layoutFor(w);
      const narrower = layoutFor(w - 37);
      if (wide.groups === 'drawer') expect(narrower.groups).toBe('drawer');
      if (wide.aside === 'drawer') expect(narrower.aside).toBe('drawer');
    }
  });
});

describe('lineIn', () => {
  it('finds a line by its old or new number cell', () => {
    const root = document.createElement('div');
    root.innerHTML = [
      '<div class="ln" id="a"><span class="no">7</span><span class="no">9</span></div>',
      '<div class="ln" id="b"><span class="no">8</span><span class="no"></span></div>',
      '<div class="ln" id="c"><span class="no"></span><span class="no">10</span></div>',
    ].join('');
    expect(lineIn(root, { side: 'new', line: 9 })?.id).toBe('a');
    expect(lineIn(root, { side: 'old', line: 8 })?.id).toBe('b');
    expect(lineIn(root, { side: 'new', line: 10 })?.id).toBe('c');
    expect(lineIn(root, { side: 'old', line: 10 })).toBeNull();
  });
});
