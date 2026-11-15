/** iOS: the SwiftUI `Host` a standalone control brings, tinted with the accent. */
import { Host } from '@expo/ui/swift-ui';
import type { ReactNode } from 'react';
import { useColorScheme, type StyleProp, type ViewStyle } from 'react-native';
import { usePalette } from '../theme';
import { useInForm } from './context';

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
  const theme = useHostTheme();
  if (inForm) return <>{children}</>;
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
