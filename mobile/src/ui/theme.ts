/**
 * Colors for light and dark, following the Theme setting (Light, Dark or
 * System; `./themeSetting.ts`).
 */
import { Platform } from 'react-native';
import { useUniwind } from 'uniwind';
import type { Tone } from './logic';
import { platformPalette } from './materialPalette';

export interface Palette {
  background: string;
  surface: string;
  surfaceMuted: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  onAccent: string;
  success: string;
  warning: string;
  danger: string;
}

export const light: Palette = {
  background: '#F2F2F7',
  surface: '#FFFFFF',
  surfaceMuted: '#E9E9EF',
  border: '#D8D8DE',
  text: '#111114',
  muted: '#6B6B76',
  // The logo's blue (assets/src), dark enough for white text (4.7:1).
  accent: '#2F74C8',
  onAccent: '#FFFFFF',
  success: '#1F9D55',
  warning: '#B7791F',
  danger: '#D93025',
};

export const dark: Palette = {
  background: '#000000',
  surface: '#1C1C1E',
  surfaceMuted: '#2C2C2E',
  border: '#38383A',
  text: '#F5F5F7',
  muted: '#9A9AA5',
  accent: '#6AA7EC',
  onAccent: '#0B0B0F',
  success: '#4CC38A',
  warning: '#F0B54A',
  danger: '#FF6B61',
};

/**
 * The scheme the app draws in: the Theme setting, or the system's under
 * System. Uniwind holds it (`Uniwind.setTheme`), so `className` tokens,
 * `usePalette()` and the native Hosts agree, on web too (where React
 * Native's `useColorScheme()` only reads the browser's).
 */
export function useScheme(): 'light' | 'dark' {
  return useUniwind().theme === 'dark' ? 'dark' : 'light';
}

/**
 * The palette for the scheme. On Android 12+ its roles come from Material
 * You (`materialPalette.android.ts`); elsewhere they are the above.
 */
export function usePalette(): Palette {
  const scheme = useScheme();
  return platformPalette(scheme === 'dark' ? dark : light, scheme);
}

/** The color a tone draws in. */
export function toneColor(p: Palette, tone: Tone): string {
  switch (tone) {
    case 'accent':
      return p.accent;
    case 'success':
      return p.success;
    case 'warning':
      return p.warning;
    case 'danger':
      return p.danger;
    default:
      return p.muted;
  }
}

export const mono = {
  fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
} as const;
