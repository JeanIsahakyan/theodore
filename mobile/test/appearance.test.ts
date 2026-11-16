import { describe, expect, it } from 'vitest';
import { THEME_CHOICES, parseTheme } from '../src/ui/appearance';
import { readTheme, writeTheme } from '../src/ui/themeStore';

describe('Theme setting', () => {
  it('offers Light, Dark and System, in that order', () => {
    expect(THEME_CHOICES.map((c) => c.label)).toEqual([
      'Light',
      'Dark',
      'System',
    ]);
  });

  it('reads back what was kept; anything else is System', () => {
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('dark')).toBe('dark');
    expect(parseTheme('system')).toBe('system');
    expect(parseTheme(null)).toBe('system');
    expect(parseTheme(undefined)).toBe('system');
    expect(parseTheme('sepia')).toBe('system');
  });

  it('defaults to System and keeps a choice', () => {
    expect(readTheme()).toBe('system');
    writeTheme('dark');
    expect(readTheme()).toBe('dark');
    writeTheme('system');
    expect(readTheme()).toBe('system');
  });
});
