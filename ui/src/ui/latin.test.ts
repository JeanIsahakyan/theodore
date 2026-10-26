import { describe, expect, it } from 'vitest';
import { latinKey } from './latin';

describe('latinKey', () => {
  it('reads the physical key on a Cyrillic layout', () => {
    expect(latinKey({ code: 'KeyJ', key: 'й' })).toBe('j');
    expect(latinKey({ code: 'BracketRight', key: 'ъ' })).toBe(']');
    expect(latinKey({ code: 'BracketLeft', key: 'х' })).toBe('[');
    expect(latinKey({ code: 'Slash', key: '.', shiftKey: true })).toBe('?');
  });

  it('passes named keys through', () => {
    expect(latinKey({ code: 'Escape', key: 'Escape' })).toBe('Escape');
    expect(latinKey({ code: 'Space', key: ' ' })).toBe(' ');
  });
});
