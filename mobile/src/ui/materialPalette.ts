/**
 * The app's palette as the platform draws it. iOS and web: the app's own
 * colors. Android 12+: Material You (`materialPalette.android.ts`).
 */
import type { Palette } from './theme';

export function platformPalette(base: Palette, _scheme: 'light' | 'dark') {
  return base;
}
