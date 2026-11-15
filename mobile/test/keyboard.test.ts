import { describe, expect, it } from 'vitest';
import { avoidBehavior, bottomPad, dismissMode } from '../src/ui/keyboard';

describe('keyboard rules', () => {
  it('pads native screens: neither window resizes for the keyboard', () => {
    expect(avoidBehavior('ios')).toBe('padding');
    expect(avoidBehavior('android')).toBe('padding');
    expect(avoidBehavior('web')).toBeUndefined();
  });

  it('closes the keyboard on a drag, interactively on iOS', () => {
    expect(dismissMode('ios')).toBe('interactive');
    expect(dismissMode('android')).toBe('on-drag');
    expect(dismissMode('web')).toBe('none');
  });

  it('leaves the home indicator inset out while the keyboard is up', () => {
    expect(bottomPad(12, 34, false)).toBe(46);
    expect(bottomPad(12, 34, true)).toBe(12);
    expect(bottomPad(12, 0, false)).toBe(12);
  });
});
