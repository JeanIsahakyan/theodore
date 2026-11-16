// Adapted from EvanBacon/chat-template (MIT)
/**
 * Web: a space's header, the JS stack's bar replaced by Back, the space's
 * name and "on <host> · <status>" under it (`space-title.tsx`).
 */
import { Stack } from 'expo-router';
import { goBack } from '../shell/PushedHeader';
import { TitleBar, type SpaceHeaderProps } from './space-title';

export function SpaceHeader({ title, subtitle }: SpaceHeaderProps) {
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
