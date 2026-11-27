// Adapted from EvanBacon/chat-template (MIT)
/**
 * Android: a Material 3 small top app bar (Compose `TopAppBar`) as the
 * stack's header: the menu as its navigation icon, the title in
 * `titleLarge`, "new space" as its action icon button. Edge to edge: React Native pads it under the status
 * bar, Compose adds no insets of its own.
 *
 * ```text
 * [☰]  New space                         [✎]
 * [☰]  fix the login bug…                [✎]   a space: two lines
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
import { useHeaderActions, type MainHeaderProps } from './header-actions';

const NO_INSETS = {};

function AppBar({
  title,
  subtitle,
  onMenu,
  onNewSpace,
}: {
  title: string;
  subtitle?: string;
  onMenu: () => void;
  onNewSpace: () => void;
}) {
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
              onClick={onMenu}
              modifiers={[semantics({ contentDescription: 'Open menu' })]}
            >
              <Icon source={require('../../assets/icons/menu.xml')} />
            </IconButton>
          </TopAppBar.NavigationIcon>
          <TopAppBar.Title>
            <Column
              modifiers={
                subtitle
                  ? [semantics({ contentDescription: `${title}, ${subtitle}` })]
                  : []
              }
            >
              <Text
                maxLines={1}
                overflow="ellipsis"
                style={{ typography: 'titleLarge' }}
              >
                {title}
              </Text>
              {subtitle ? (
                <Text
                  maxLines={1}
                  overflow="ellipsis"
                  color={p.muted}
                  style={{ typography: 'bodyMedium' }}
                >
                  {subtitle}
                </Text>
              ) : null}
            </Column>
          </TopAppBar.Title>
          <TopAppBar.Actions>
            <IconButton
              onClick={onNewSpace}
              modifiers={[semantics({ contentDescription: 'New space' })]}
            >
              <Icon source={require('../../assets/icons/edit.xml')} />
            </IconButton>
          </TopAppBar.Actions>
        </TopAppBar>
      </Host>
    </View>
  );
}

export function MainHeader({ title, subtitle, onNewSpace }: MainHeaderProps) {
  const { openDrawer, newSpace } = useHeaderActions(onNewSpace);
  return (
    <Stack.Screen
      options={{
        title,
        header: () => (
          <AppBar
            title={title}
            subtitle={subtitle}
            onMenu={openDrawer}
            onNewSpace={newSpace}
          />
        ),
      }}
    />
  );
}
