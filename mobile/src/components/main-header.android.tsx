// Adapted from EvanBacon/chat-template (MIT)
/**
 * Android: a Material 3 small top app bar (Compose `TopAppBar`) as the
 * stack's header: the menu as its navigation icon, the title in
 * `titleLarge`, actions as icon buttons (the questions bell with a badge
 * while one waits). Edge to edge: React Native pads it under the status
 * bar, Compose adds no insets of its own.
 *
 * ```text
 * [☰]  New space                     [🔔³][✎]
 * ```
 */
import {
  Badge,
  BadgedBox,
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
  waiting,
  onMenu,
  onQuestions,
  onNewSpace,
}: {
  title: string;
  waiting: number;
  onMenu: () => void;
  onQuestions: () => void;
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
            <Text
              maxLines={1}
              overflow="ellipsis"
              style={{ typography: 'titleLarge' }}
            >
              {title}
            </Text>
          </TopAppBar.Title>
          <TopAppBar.Actions>
            {waiting > 0 ? (
              <IconButton
                // Remounted as it shows (Compose keeps its first handler).
                key={`questions-${waiting}`}
                onClick={onQuestions}
                modifiers={[
                  semantics({
                    contentDescription: `${waiting} question${waiting === 1 ? '' : 's'} waiting`,
                  }),
                ]}
              >
                <BadgedBox>
                  <BadgedBox.Badge>
                    <Badge>
                      <Text>{String(waiting)}</Text>
                    </Badge>
                  </BadgedBox.Badge>
                  <Icon
                    source={require('../../assets/icons/notifications.xml')}
                  />
                </BadgedBox>
              </IconButton>
            ) : null}
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

export function MainHeader({ title, onNewSpace }: MainHeaderProps) {
  const { openDrawer, newSpace, waiting, openQuestions } =
    useHeaderActions(onNewSpace);
  return (
    <Stack.Screen
      options={{
        title,
        header: () => (
          <AppBar
            title={title}
            waiting={waiting}
            onMenu={openDrawer}
            onQuestions={openQuestions}
            onNewSpace={newSpace}
          />
        ),
      }}
    />
  );
}
