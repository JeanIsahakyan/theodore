/**
 * Where the Theme setting is kept. Default (Node / tests): memory. Metro
 * picks `themeStore.native.ts` (secure-store) or `themeStore.web.ts`
 * (localStorage). Reads are synchronous: the theme is applied before the
 * first screen draws.
 */
import { parseTheme, type ThemePreference } from './appearance';

let kept: string | null = null;

export function readTheme(): ThemePreference {
  return parseTheme(kept);
}

export function writeTheme(theme: ThemePreference): void {
  kept = theme;
}
