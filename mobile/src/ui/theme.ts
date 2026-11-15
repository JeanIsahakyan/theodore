/** Colors for light and dark, following the system scheme. */
import { Platform, useColorScheme } from 'react-native';
import type { Tone } from './logic';

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
  accent: '#3D5AFE',
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
  accent: '#7C93FF',
  onAccent: '#0B0B0F',
  success: '#4CC38A',
  warning: '#F0B54A',
  danger: '#FF6B61',
};

export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? dark : light;
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
