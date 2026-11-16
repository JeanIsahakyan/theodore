/**
 * `Glass` without Liquid Glass (iOS before 26, Android, web; `Glass.tsx`,
 * `Glass.ios.tsx`): a surface for React Native content that floats over
 * the screen (a banner, a composer's notes, a question waiting for you).
 *
 * ```text
 * iOS 26+           Liquid Glass (GlassView), `Glass.ios.tsx`
 * iOS < 26, web     the `fallback`: a card (surface), a quiet pill (muted), nothing
 * Android           the same, in Material You's surface roles (usePalette)
 * ```
 */
import { View } from 'react-native';
import { usePalette } from '../theme';
import type { GlassProps } from './types';

export function PlainGlass({
  shape = 'rounded',
  radius = 20,
  interactive: _interactive,
  tint: _tint,
  fallback = 'surface',
  style,
  children,
  ...view
}: GlassProps) {
  const p = usePalette();
  const backgroundColor =
    fallback === 'surface'
      ? p.surface
      : fallback === 'muted'
        ? p.surfaceMuted
        : 'transparent';
  return (
    <View
      {...view}
      style={[
        {
          backgroundColor,
          borderRadius: shape === 'capsule' ? 999 : radius,
        },
        shape === 'capsule' ? null : { borderCurve: 'continuous' },
        style,
      ]}
    >
      {children}
    </View>
  );
}
