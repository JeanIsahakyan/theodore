// Adapted from EvanBacon/chat-template (MIT)
/**
 * A blur filling its parent, behind the parent's content: the glass
 * fallback below iOS 26. Android (Material surfaces are solid) and web
 * draw none (`blur-raw.android.tsx`, `blur-raw.web.tsx`).
 */
import { BlurView, type BlurViewProps } from 'expo-blur';
import { StyleSheet } from 'react-native';

export function BlurViewRawBackdrop({
  tint = 'systemChromeMaterial',
  intensity = 50,
}: Pick<BlurViewProps, 'tint' | 'intensity'>) {
  return (
    <BlurView
      tint={tint}
      intensity={intensity}
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { overflow: 'hidden' }]}
    />
  );
}
