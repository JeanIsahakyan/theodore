// Adapted from EvanBacon/chat-template (MIT)
/**
 * A pressable glass surface (round buttons floating over content).
 *
 * ```text
 * iOS 26+   interactive Liquid Glass (GlassView), a native tap gesture
 * iOS < 26  blur behind, grows a little while pressed
 * Android   a Material ripple on the surface's own (className) color
 * web       a plain pressable
 * ```
 */
import { isLiquidGlassAvailable } from 'expo-glass-effect';
import { useState, type ReactNode } from 'react';
import {
  Pressable,
  type AccessibilityRole,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { withUniwind } from 'uniwind';
import { BlurViewRawBackdrop } from './blur-raw';
import { AppleGlassView } from './tw';

export interface TouchableGlassProps {
  onPress?: () => void;
  disabled?: boolean;
  children?: ReactNode;
  className?: string;
  style?: StyleProp<ViewStyle>;
  hitSlop?: number;
  accessibilityLabel?: string;
  accessibilityRole?: AccessibilityRole;
  testID?: string;
}

const AnimatedView = withUniwind(Animated.View);

function TouchableGlassNative({
  onPress,
  disabled,
  children,
  className,
  style,
  accessibilityLabel,
  accessibilityRole = 'button',
  testID,
}: TouchableGlassProps) {
  const tap = Gesture.Tap()
    .enabled(!disabled)
    .onEnd((_e, success) => {
      if (success && onPress) scheduleOnRN(onPress);
    });
  return (
    <GestureDetector gesture={tap}>
      <AppleGlassView
        collapsable={false}
        isInteractive={!disabled}
        className={className}
        style={style}
        accessible
        accessibilityRole={accessibilityRole}
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ disabled: !!disabled }}
        testID={testID}
      >
        {children}
      </AppleGlassView>
    </GestureDetector>
  );
}

function TouchableGlassFallback({
  onPress,
  disabled,
  children,
  className,
  style,
  hitSlop,
  accessibilityLabel,
  accessibilityRole = 'button',
  testID,
}: TouchableGlassProps) {
  const [pressed, setPressed] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      disabled={disabled}
      hitSlop={hitSlop}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !!disabled }}
      testID={testID}
      android_ripple={{ borderless: false, foreground: true }}
    >
      <AnimatedView
        className={className}
        style={[
          {
            overflow: 'hidden',
            transitionDuration: 150,
            transitionProperty: ['transform', 'opacity'],
            transitionTimingFunction: 'ease-in-out',
          },
          pressed && process.env.EXPO_OS === 'ios'
            ? { transform: [{ scale: 1.08 }] }
            : null,
          disabled ? { opacity: 0.5 } : null,
          style,
        ]}
      >
        <BlurViewRawBackdrop />
        {children}
      </AnimatedView>
    </Pressable>
  );
}

export const TouchableGlass = isLiquidGlassAvailable()
  ? TouchableGlassNative
  : TouchableGlassFallback;
