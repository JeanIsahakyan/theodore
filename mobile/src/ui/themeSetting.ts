/**
 * Applies the Theme setting app-wide (docs/mobile.md "Theme").
 *
 * ```text
 * start          readTheme() ─▶ Uniwind.setTheme(t)
 * Settings pick  Uniwind.setTheme(t) ─▶ writeTheme(t)
 *
 * Uniwind.setTheme   className tokens (src/global.css, light / dark variants)
 *   native           + Appearance.setColorScheme: UIKit / AppCompat follow
 *                      (headers, alerts, keyboard, status bar)
 * useScheme()        Uniwind's current theme ─▶ usePalette() and every
 *                    Host's colorScheme (SwiftUI / Compose)
 * ```
 */
import { Uniwind } from 'uniwind';
import { create } from 'zustand';
import type { ThemePreference } from './appearance';
import { readTheme, writeTheme } from './themeStore';

export const useThemeSetting = create<{ theme: ThemePreference }>(() => ({
  theme: 'system',
}));

/** Once, before the first screen: the kept choice, else System. */
export function initTheme(): void {
  const theme = readTheme();
  useThemeSetting.setState({ theme });
  Uniwind.setTheme(theme);
}

export function setTheme(theme: ThemePreference): void {
  if (useThemeSetting.getState().theme === theme) return;
  useThemeSetting.setState({ theme });
  Uniwind.setTheme(theme);
  writeTheme(theme);
}
