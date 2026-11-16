// Adapted from EvanBacon/chat-template (MIT)
/**
 * Web: the composer under the content, centered and at most 768 px wide
 * (the browser handles its own keyboard).
 */
import { View } from 'react-native';
import type { ComposerDockProps } from './types';

export function ComposerDock({
  children,
  floating,
  onHeight,
}: ComposerDockProps) {
  return (
    <View
      onLayout={(e) => onHeight?.(e.nativeEvent.layout.height)}
      className={`z-10 mx-auto w-full max-w-3xl bg-background px-3 pb-3 md:px-4 md:pb-4 ${floating ? 'absolute right-0 bottom-0 left-0' : ''}`}
    >
      {children}
    </View>
  );
}
