/**
 * Android: Material 3 color roles for the app's palette, so React Native
 * text and surfaces match the Compose controls (`native/host.android.tsx`).
 *
 * | Palette | Android 12+ (Material You) | below 12 |
 * | --- | --- | --- |
 * | background | `surface` | the app's |
 * | surface (cards) | `surfaceContainerLow` | the app's |
 * | surfaceMuted | `surfaceContainerHigh` | the app's |
 * | border | `outlineVariant` | the app's |
 * | text / muted | `onSurface` / `onSurfaceVariant` | the app's |
 * | accent / onAccent | `primary` / `onPrimary` | `#2F74C8` / white |
 * | danger | `error` | the app's |
 *
 * Success and warning stay the app's: Material has no such roles. The
 * wallpaper palette is read once per scheme (a native call); a new
 * wallpaper shows after the app restarts.
 */
import {
  getMaterialColors,
  isDynamicColorAvailable,
} from '@expo/ui/jetpack-compose';
import type { Palette } from './theme';

const cache = new Map<'light' | 'dark', Palette>();

export function platformPalette(
  base: Palette,
  scheme: 'light' | 'dark',
): Palette {
  if (!isDynamicColorAvailable) return base;
  const hit = cache.get(scheme);
  if (hit) return hit;
  const m = getMaterialColors({ scheme });
  const palette: Palette = {
    ...base,
    background: m.surface,
    surface: m.surfaceContainerLow,
    surfaceMuted: m.surfaceContainerHigh,
    border: m.outlineVariant,
    text: m.onSurface,
    muted: m.onSurfaceVariant,
    accent: m.primary,
    onAccent: m.onPrimary,
    danger: m.error,
  };
  cache.set(scheme, palette);
  return palette;
}
