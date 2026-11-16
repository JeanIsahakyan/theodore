// Adapted from EvanBacon/chat-template (MIT)
/**
 * Android: a space's header as a Material 3 small top app bar (Compose
 * `TopAppBar`), like the main header: the back arrow, the space's name
 * in `titleLarge` cut with "…", "on <host> · <status>" under it in
 * `bodyMedium` / onSurfaceVariant. Edge to edge: React Native pads it
 * under the status bar, Compose adds no insets of its own.
 *
 * ```text
 * [←]  fix the login bug…
 *      on mac-A · Running
 * ```
 */
import {
  Column,
  Host,
  Icon,
  IconButton,
  Text,
  TopAppBar,
} from '@expo/ui/jetpack-compose';
import { semantics } from '@expo/ui/jetpack-compose/modifiers';
import { Stack } from 'expo-router';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHostTheme } from '../ui/native/host.android';
import { usePalette } from '../ui/theme';
import { goBack } from '../shell/PushedHeader';
import type { SpaceHeaderProps } from './space-title';

const NO_INSETS = {};

function AppBar({ title, subtitle }: SpaceHeaderProps) {
  const p = usePalette();
  const theme = useHostTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        paddingTop: insets.top,
        paddingLeft: insets.left,
        paddingRight: insets.right,
        backgroundColor: p.background,
      }}
    >
      <Host {...theme} matchContents={{ vertical: true }}>
        <TopAppBar
          windowInsets={NO_INSETS}
          colors={{
            containerColor: p.background,
            titleContentColor: p.text,
            navigationIconContentColor: p.text,
            actionIconContentColor: p.muted,
          }}
        >
          <TopAppBar.NavigationIcon>
            <IconButton
              onClick={goBack}
              modifiers={[semantics({ contentDescription: 'Back' })]}
            >
              <Icon source={require('../../assets/icons/arrow_back.xml')} />
            </IconButton>
          </TopAppBar.NavigationIcon>
          <TopAppBar.Title>
            <Column
              modifiers={[
                semantics({ contentDescription: `${title}, ${subtitle}` }),
              ]}
            >
              <Text
                maxLines={1}
                overflow="ellipsis"
                style={{ typography: 'titleLarge' }}
              >
                {title}
              </Text>
              <Text
                maxLines={1}
                overflow="ellipsis"
                color={p.muted}
                style={{ typography: 'bodyMedium' }}
              >
                {subtitle}
              </Text>
            </Column>
          </TopAppBar.Title>
        </TopAppBar>
      </Host>
    </View>
  );
}

export function SpaceHeader({ title, subtitle }: SpaceHeaderProps) {
  return (
    <Stack.Screen
      options={{
        title,
        header: () => <AppBar title={title} subtitle={subtitle} />,
      }}
    />
  );
}
