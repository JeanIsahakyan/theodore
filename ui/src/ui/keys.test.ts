import { describe, expect, it } from 'vitest';
import { latinKey } from './keys';

describe('latinKey', () => {
  it('maps a letter code to its lowercase Latin letter regardless of e.key', () => {
    // A Cyrillic layout: physically the "J" key, but `e.key` is "о".
    expect(latinKey({ code: 'KeyJ', key: 'о' })).toBe('j');
  });

  it('maps digit codes', () => {
    expect(latinKey({ code: 'Digit1', key: '1' })).toBe('1');
  });

  it('falls back to e.key for keys with no letter/digit code', () => {
    expect(latinKey({ code: 'Escape', key: 'Escape' })).toBe('Escape');
    expect(latinKey({ code: 'Slash', key: '/' })).toBe('/');
  });

  it('is stable on a plain US layout', () => {
    expect(latinKey({ code: 'KeyV', key: 'v' })).toBe('v');
  });
});
