// Adapted from EvanBacon/chat-template (MIT)
import type { BlurViewProps } from 'expo-blur';

/** Web: no backdrop blur; the surface's own color shows. */
export function BlurViewRawBackdrop(
  _props: Pick<BlurViewProps, 'tint' | 'intensity'>,
) {
  return null;
}
