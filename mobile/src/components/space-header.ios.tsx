// Adapted from EvanBacon/chat-template (MIT)
/**
 * iOS: a space's header in the main header's style for a pushed screen.
 *
 * ```text
 * 26+    native Liquid Glass bar, "‹" back (minimal), the two-line title
 *        as its title view; nothing painted behind it
 * < 26   the RN bar (`space-title.tsx` TitleBar): "‹ Back", the two lines
 * ```
 */
import { Stack } from 'expo-router';
import { useWindowDimensions } from 'react-native';
import { glassHeader } from '../shell/glassHeader';
import { goBack } from '../shell/PushedHeader';
import { TitleBar, TitleStack, type SpaceHeaderProps } from './space-title';

/** Room left for the bar's back button and a trailing item. */
const SIDES = 150;

export function SpaceHeader({ title, subtitle }: SpaceHeaderProps) {
  const { width } = useWindowDimensions();
  if (glassHeader) {
    return (
      <Stack.Screen
        options={{
          title,
          headerTitle: () => (
            <TitleStack
              title={title}
              subtitle={subtitle}
              maxWidth={Math.max(120, width - SIDES)}
            />
          ),
        }}
      />
    );
  }
  return (
    <Stack.Screen
      options={{
        title,
        header: () => (
          <TitleBar title={title} subtitle={subtitle} onBack={goBack} />
        ),
      }}
    />
  );
}
