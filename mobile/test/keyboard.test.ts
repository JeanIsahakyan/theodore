import { describe, expect, it } from 'vitest';
import { dismissMode } from '../src/ui/keyboard';

describe('keyboard rules', () => {
  it('closes the keyboard on a drag, interactively on iOS', () => {
    expect(dismissMode('ios')).toBe('interactive');
    expect(dismissMode('android')).toBe('on-drag');
    expect(dismissMode('web')).toBe('none');
  });
});
