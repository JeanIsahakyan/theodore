import { describe, expect, it } from 'vitest';
import { DIFF_MIN, layoutFor } from './Review';

describe('layoutFor', () => {
  it('keeps both panes as columns when there is room for all three', () => {
    expect(layoutFor(1600)).toEqual({ groups: 'column', aside: 'column' });
  });

  it('drops the aside to a drawer first as width shrinks', () => {
    expect(layoutFor(1200)).toEqual({ groups: 'column', aside: 'drawer' });
  });

  it('drops the groups pane to a drawer too once narrower still', () => {
    expect(layoutFor(1000)).toEqual({ groups: 'drawer', aside: 'drawer' });
  });

  it('is stable at the minimum supported window width', () => {
    // 900×600 minimum, minus a ~256px sidebar still leaves room for the
    // diff's own floor — both panes collapse, nothing is forced negative.
    const layout = layoutFor(900 - 256);
    expect(layout).toEqual({ groups: 'drawer', aside: 'drawer' });
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
