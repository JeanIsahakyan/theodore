// Adapted from EvanBacon/chat-template (MIT)
/**
 * Third-party views with `className` (Uniwind), and the glass surface the
 * shell floats over content:
 *
 * ```text
 * AppleGlassView  iOS 26+: GlassView (Liquid Glass; a backgroundColor
 *                 class becomes its tint)   below 26 / Android / web: BlurView
 * ```
 */
import { BlurView as EXBlurView } from 'expo-blur';
import {
  GlassView as XGlassView,
  isLiquidGlassAvailable,
} from 'expo-glass-effect';
import { Image as XImage } from 'expo-image';
import type { ComponentProps, ReactNode } from 'react';
import { StyleSheet, type ViewStyle } from 'react-native';
import { SafeAreaView as XSafeAreaView } from 'react-native-safe-area-context';
import { withUniwind } from 'uniwind';

export const SafeAreaView = withUniwind(XSafeAreaView);
export const Image = withUniwind(XImage);
export const GlassView = withUniwind(XGlassView);
const BlurView = withUniwind(EXBlurView);

const GLASS_ENABLED = isLiquidGlassAvailable();

type GlassProps = ComponentProps<typeof XGlassView> & {
  className?: string;
  fallbackTint?: ComponentProps<typeof EXBlurView>['tint'];
  fallbackIntensity?: ComponentProps<typeof EXBlurView>['intensity'];
};

/** Liquid Glass with `style.backgroundColor` moved to its tint. */
function BetterGlassView({
  fallbackTint: _t,
  fallbackIntensity: _i,
  style,
  ...rest
}: GlassProps) {
  const { backgroundColor: tint, ...flat } = (StyleSheet.flatten(style) ??
    {}) as ViewStyle;
  return (
    <XGlassView
      {...rest}
      style={flat}
      {...(typeof tint === 'string' ? { tintColor: tint } : null)}
    />
  );
}

function FallbackGlassView({
  fallbackTint,
  fallbackIntensity,
  children,
  style,
  className,
}: GlassProps) {
  return (
    <BlurView
      className={className}
      style={[{ overflow: 'hidden' }, StyleSheet.flatten(style) as ViewStyle]}
      tint={fallbackTint}
      intensity={fallbackIntensity}
    >
      {children as ReactNode}
    </BlurView>
  );
}

export const AppleGlassView = GLASS_ENABLED
  ? withUniwind(BetterGlassView)
  : FallbackGlassView;
