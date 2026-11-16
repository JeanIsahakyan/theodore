/** Web: the Theme setting in `localStorage` (per origin, every tab). */
import { THEME_KEY, parseTheme, type ThemePreference } from './appearance';

export function readTheme(): ThemePreference {
  try {
    return parseTheme(globalThis.localStorage?.getItem(THEME_KEY));
  } catch {
    return 'system';
  }
}

export function writeTheme(theme: ThemePreference): void {
  try {
    globalThis.localStorage?.setItem(THEME_KEY, theme);
  } catch {
    // Storage off or full: the choice holds until the page closes.
  }
}
