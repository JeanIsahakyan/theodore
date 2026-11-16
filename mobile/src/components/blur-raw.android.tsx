// Adapted from EvanBacon/chat-template (MIT)
import type { BlurViewProps } from 'expo-blur';

/** Android: Material 3 surfaces are solid tonal colors, never blurred. */
export function BlurViewRawBackdrop(
  _props: Pick<BlurViewProps, 'tint' | 'intensity'>,
) {
  return null;
}
