// Adapted from EvanBacon/chat-template (MIT)
/**
 * What the agent is writing right now: the text so far, plain (it becomes
 * markdown once the step is done), with the template's block cursor; and
 * the shimmering status line of a turn still going.
 *
 * ```text
 * The tests pass, now the docs▌
 * Working · 12s          (opacity pulses 0.35 ↔ 1)
 * ```
 */
import { useEffect, type ReactNode } from 'react';
import { Text } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { withUniwind } from 'uniwind';

const web = process.env.EXPO_OS === 'web';
const AnimatedText = withUniwind(Animated.Text);

export function StreamingMessage({ text }: { text: string }) {
  return (
    <Text
      selectable={web}
      className={
        web
          ? 'text-[15px] leading-[1.6] text-foreground'
          : 'text-base leading-[22px] text-foreground'
      }
    >
      {text || '...'}
      <Text className="opacity-40">{'▌'}</Text>
    </Text>
  );
}

/** A label that pulses while something runs. */
export function Shimmer({
  children,
  className = 'text-[13px] text-muted-foreground',
}: {
  children: ReactNode;
  className?: string;
}) {
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.value = withRepeat(
      withTiming(0.35, { duration: 900, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
    return () => cancelAnimation(opacity);
  }, [opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <AnimatedText className={className} style={style}>
      {children}
    </AnimatedText>
  );
}
