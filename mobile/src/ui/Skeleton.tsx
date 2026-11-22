/**
 * Placeholders for what hasn't loaded yet (docs/mobile.md "First
 * connection"): muted blocks that breathe (opacity 1 ─▶ 0.45 ─▶ 1 over
 * 1.6 s, reanimated), still under Reduce Motion. Hidden from assistive
 * tech: the screen around them says "Loading" once.
 *
 * ```text
 * Skeleton      one block: width, height, radius (default a pill)
 * SkeletonChip  the size of Home's project / computer / model chips (30 high)
 * SkeletonRow   a drawer row: a title line and a shorter detail line
 * ```
 */
import { useEffect } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { usePalette } from './theme';

const android = process.env.EXPO_OS === 'android';
/** One breath, there and back. */
const PERIOD_MS = 1600;
const DIM = 0.45;

export function Skeleton({
  width,
  height = 14,
  radius = 999,
  style,
}: {
  width: number | `${number}%`;
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const p = usePalette();
  const still = useReducedMotion();
  const opacity = useSharedValue(1);

  useEffect(() => {
    if (still) {
      opacity.set(0.7);
      return undefined;
    }
    opacity.set(
      withRepeat(
        withSequence(
          withTiming(DIM, {
            duration: PERIOD_MS / 2,
            easing: Easing.inOut(Easing.ease),
          }),
          withTiming(1, {
            duration: PERIOD_MS / 2,
            easing: Easing.inOut(Easing.ease),
          }),
        ),
        -1,
      ),
    );
    return () => cancelAnimation(opacity);
  }, [still, opacity]);

  const animated = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          width,
          height,
          borderRadius: radius,
          backgroundColor: p.surfaceMuted,
        },
        animated,
        style,
      ]}
    />
  );
}

/** A chip-sized block: Home's project, computer and model chips. */
export function SkeletonChip({
  width = 112,
  style,
}: {
  width?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return <Skeleton width={width} height={android ? 32 : 30} style={style} />;
}

/** A drawer row's lines; `wide` varies the title's length row by row. */
export function SkeletonRow({ wide }: { wide: number }) {
  return (
    <View
      style={android ? styles.rowAndroid : styles.row}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Skeleton width={`${wide}%`} height={13} />
      <Skeleton width="38%" height={10} />
    </View>
  );
}

/** The drawer's list while the spaces haven't loaded yet. */
export function SkeletonRows({ count = 5 }: { count?: number }) {
  const widths = [72, 56, 80, 64, 48, 70];
  return (
    <View accessibilityLabel="Loading spaces" accessibilityRole="progressbar">
      {Array.from({ length: count }, (_, i) => (
        <SkeletonRow key={i} wide={widths[i % widths.length]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    marginHorizontal: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 8,
  },
  rowAndroid: {
    marginHorizontal: 12,
    paddingHorizontal: 16,
    height: 56,
    justifyContent: 'center',
    gap: 8,
  },
});
