/**
 * Light / dark, the way the desktop app does it (ui/src/stores/UiStore.ts):
 * a stored preference or the system's, applied as the `.dark` class HeroUI
 * reads and `data-theme`. The inline script in index.html applies the same
 * rule before the first paint.
 */
export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'theodore-theme';
export const THEME_EVENT = 'theodore-theme';

const darkQuery = () =>
  typeof matchMedia === 'undefined'
    ? null
    : matchMedia('(prefers-color-scheme: dark)');

export function themePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function isDark(): boolean {
  return document.documentElement.classList.contains('dark');
}

function applyTheme(pref: ThemePref): void {
  const dark = pref === 'dark' || (pref === 'system' && !!darkQuery()?.matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

export function setThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    // private mode: the choice lasts for this page
  }
  applyTheme(pref);
  window.dispatchEvent(new Event(THEME_EVENT));
}

/** The nav's toggle: flips what's on screen and pins it. */
export function toggleTheme(): void {
  setThemePref(isDark() ? 'light' : 'dark');
}

/** Follow the system while the preference is "system". */
export function watchSystemTheme(): void {
  darkQuery()?.addEventListener('change', () => {
    if (themePref() !== 'system') return;
    applyTheme('system');
    window.dispatchEvent(new Event(THEME_EVENT));
  });
}
