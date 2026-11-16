/**
 * iOS: a Liquid Glass surface for React Native content (`GlassView`) on iOS
 * 26+; below it the `fallback` look of `./PlainGlass.tsx`.
 */
import { GlassView } from 'expo-glass-effect';
import { liquidGlass } from './liquidGlass';
import { PlainGlass as Plain } from './PlainGlass';
import type { GlassProps } from './types';

export function Glass({
  shape = 'rounded',
  radius = 20,
  interactive,
  tint,
  fallback,
  style,
  children,
  ...view
}: GlassProps) {
  if (!liquidGlass) {
    return (
      <Plain
        shape={shape}
        radius={radius}
        fallback={fallback}
        style={style}
        {...view}
      >
        {children}
      </Plain>
    );
  }
  return (
    <GlassView
      {...view}
      glassEffectStyle="regular"
      isInteractive={!!interactive}
      {...(tint ? { tintColor: tint } : {})}
      style={[
        { borderRadius: shape === 'capsule' ? 999 : radius },
        shape === 'capsule' ? null : { borderCurve: 'continuous' },
        style,
      ]}
    >
      {children}
    </GlassView>
  );
}
