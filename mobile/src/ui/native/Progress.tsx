/** Web: React Native `ActivityIndicator`, or a bar. */
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { usePalette } from '../theme';
import type { ProgressProps } from './types';

export function Progress({
  value,
  variant = 'circular',
  accessibilityLabel,
  testID,
  style,
}: ProgressProps) {
  const p = usePalette();
  if (variant === 'circular' || value == null) {
    return (
      <ActivityIndicator
        accessibilityLabel={accessibilityLabel}
        testID={testID}
        color={p.accent}
        style={style}
      />
    );
  }
  const now = Math.max(0, Math.min(1, value));
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(now * 100) }}
      testID={testID}
      style={[styles.track, { backgroundColor: p.surfaceMuted }, style]}
    >
      <View
        style={[
          styles.bar,
          { width: `${now * 100}%`, backgroundColor: p.accent },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  bar: { height: 4, borderRadius: 2 },
});
