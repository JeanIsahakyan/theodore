/** iOS: the SwiftUI `Host` a standalone control brings, tinted with the accent. */
import { Host } from '@expo/ui/swift-ui';
import {
  glassEffect,
  padding,
  type ModifierConfig,
} from '@expo/ui/swift-ui/modifiers';
import type { ReactNode } from 'react';
import { useColorScheme, type StyleProp, type ViewStyle } from 'react-native';
import { usePalette } from '../theme';
import { useInForm, useInHost } from './context';
import { liquidGlass } from './liquidGlass';

export function useHostTheme() {
  const scheme = useColorScheme();
  const p = usePalette();
  return {
    colorScheme: scheme === 'dark' ? ('dark' as const) : ('light' as const),
    seedColor: p.accent,
  };
}

/**
 * `width`: `content` sizes to the control; `fill` takes the width React
 * Native gives it (fields, full-width buttons) and the control's height.
 *
 * The container safe area is ignored: a control is laid out by React
 * Native, and one scrolled under a glass header or tab bar would otherwise
 * shift its content by the bar's height. The keyboard's still applies.
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
      ignoreSafeArea="container"
      style={style}
    >
      {children}
    </Host>
  );
}

/**
 * A Liquid Glass shape behind a control (iOS 26+); nothing below iOS 26,
 * where the control keeps its own look. `inset` pads the control inside
 * the glass.
 */
export function glassBehind(
  shape: 'capsule' | 'rounded',
  { radius = 20, inset = 0, interactive = false } = {},
): ModifierConfig[] {
  if (!liquidGlass) return [];
  return [
    ...(inset ? [padding({ all: inset })] : []),
    glassEffect({
      glass: { variant: 'regular', interactive },
      shape: shape === 'capsule' ? 'capsule' : 'roundedRectangle',
      cornerRadius: radius,
    }),
  ];
}
