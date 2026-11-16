/**
 * The Theme setting (Settings → Appearance), as plain values: what can be
 * chosen and how a stored value reads back. Applying it is
 * `./themeSetting.ts`; keeping it, `./themeStore*.ts`.
 *
 * ```text
 * Light | Dark | System (default) ─▶ Uniwind.setTheme ─▶ className tokens
 *                                   ├▶ native: the Appearance override (UIKit / AppCompat)
 *                                   └▶ usePalette(), every Host's colorScheme
 * ```
 */

export type ThemePreference = 'light' | 'dark' | 'system';

/** The key it is kept under on the device (secure-store / localStorage). */
export const THEME_KEY = 'theodore.appearance.theme';

/** The picker's choices, in the order the menu shows them. */
export const THEME_CHOICES: readonly {
  value: ThemePreference;
  label: string;
}[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

/** A kept value read back; anything else (nothing kept yet): System. */
export function parseTheme(raw: string | null | undefined): ThemePreference {
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}
