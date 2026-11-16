// Adapted from EvanBacon/chat-template (MIT)
/**
 * Holds the composer at the bottom and on top of the keyboard
 * (react-native-keyboard-controller, frame by frame on the UI thread; on
 * Android edge to edge it is the IME padding).
 *
 * ```text
 * bottom = max(safe-area bottom, keyboard height) + 8
 * in flow   the content above shrinks with it (Home's empty state)
 * floating  over the content; the content insets itself by onHeight
 * ```
 */
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DOCK_GAP as GAP, type ComposerDockProps } from './types';

export function ComposerDock({
  children,
  floating,
  onHeight,
}: ComposerDockProps) {
  const insets = useSafeAreaInsets();
  const { height } = useReanimatedKeyboardAnimation();
  const style = useAnimatedStyle(
    () => {
      // `height` is negative while the keyboard is up.
      const bottom = Math.max(insets.bottom, -height.value) + GAP;
      return floating ? { bottom } : { paddingBottom: bottom };
    },
    process.env.EXPO_OS === 'web' ? [floating, insets.bottom] : undefined,
  );
  return (
    <Animated.View
      onLayout={(e) => onHeight?.(e.nativeEvent.layout.height)}
      style={[
        {
          paddingLeft: Math.max(insets.left, 12),
          paddingRight: Math.max(insets.right, 12),
        },
        floating ? { position: 'absolute', left: 0, right: 0 } : null,
        style,
      ]}
    >
      {children}
    </Animated.View>
  );
}
