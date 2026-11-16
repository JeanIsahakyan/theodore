/**
 * Android: the Compose `Host` a standalone control brings, Material 3.
 *
 * ```text
 * Android 12+   no seed: Material You, the wallpaper's dynamic palette
 * below 12      seeded with the accent, primary = the app's accent exactly
 * ```
 *
 * `usePalette()` follows the same palette (`../materialPalette.android.ts`),
 * so React Native text and surfaces match the Compose controls.
 */
import { Host, isDynamicColorAvailable } from '@expo/ui/jetpack-compose';
import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { usePalette, useScheme } from '../theme';
import { useInForm, useInHost } from './context';

const hex = (c: string) => c as `#${string}`;

export function useHostTheme() {
  const scheme = useScheme();
  const p = usePalette();
  const colorScheme =
    scheme === 'dark' ? ('dark' as const) : ('light' as const);
  if (isDynamicColorAvailable) return { colorScheme };
  return {
    colorScheme,
    seedColor: p.accent,
    // The seed makes a tonal palette; the app's own accent stays exact.
    colorOverrides: { primary: hex(p.accent), onPrimary: hex(p.onAccent) },
  };
}

/**
 * `width`: `content` sizes to the control; `fill` takes the width React
 * Native gives it (fields, full-width buttons) and the control's height.
 */
export function ControlHost({
  children,
  style,
  width = 'content',
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  width?: 'content' | 'fill';
}) {
  const inForm = useInForm();
  const inHost = useInHost();
  const theme = useHostTheme();
  if (inForm || inHost) return <>{children}</>;
  return (
    <Host
      {...theme}
      matchContents={width === 'fill' ? { vertical: true } : true}
      style={style}
    >
      {children}
    </Host>
  );
}
