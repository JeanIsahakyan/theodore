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
 * [☰]  fix the login bug…            [🔔³][✎][⋮]   a space: two lines, ⋮ a
 *      on mac-A · Running                          DropdownMenu with `menu` items
 * ```
 */
import {
  Badge,
  BadgedBox,
  Column,
  DropdownMenu,
  DropdownMenuItem,
  Host,
  Icon,
  IconButton,
  Text,
  TopAppBar,
} from '@expo/ui/jetpack-compose';
import { semantics } from '@expo/ui/jetpack-compose/modifiers';
import { Stack } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHostTheme } from '../ui/native/host.android';
import { usePalette } from '../ui/theme';
import {
  useHeaderActions,
  type HeaderMenuItem,
  type MainHeaderProps,
} from './header-actions';

const NO_INSETS = {};

/** The "⋮" action and its dropdown. */
function MoreAction({ items }: { items: HeaderMenuItem[] }) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu expanded={open} onDismissRequest={() => setOpen(false)}>
      <DropdownMenu.Trigger>
        <IconButton
          onClick={() => setOpen(true)}
          modifiers={[semantics({ contentDescription: 'More' })]}
        >
          <Icon source={require('../../assets/icons/more_vert.xml')} />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Items>
        {items.map((it) => (
          <DropdownMenuItem
            key={it.label}
            onClick={() => {
              setOpen(false);
              it.onPress();
            }}
          >
            <DropdownMenuItem.Text>
              <Text color={it.destructive ? p.danger : p.text}>{it.label}</Text>
            </DropdownMenuItem.Text>
          </DropdownMenuItem>
        ))}
      </DropdownMenu.Items>
    </DropdownMenu>
  );
}

function AppBar({
  title,
  subtitle,
  waiting,
  onMenu,
  onQuestions,
  onNewSpace,
  menu,
}: {
  title: string;
  subtitle?: string;
  waiting: number;
  onMenu: () => void;
  onQuestions: () => void;
  onNewSpace: () => void;
  menu?: HeaderMenuItem[];
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
            {menu?.length ? <MoreAction items={menu} /> : null}
          </TopAppBar.Actions>
        </TopAppBar>
      </Host>
    </View>
  );
}

export function MainHeader({
  title,
  subtitle,
  onNewSpace,
  menu,
}: MainHeaderProps) {
  const { openDrawer, newSpace, waiting, openQuestions } =
    useHeaderActions(onNewSpace);
  return (
    <Stack.Screen
      options={{
        title,
        header: () => (
          <AppBar
            title={title}
            subtitle={subtitle}
            waiting={waiting}
            onMenu={openDrawer}
            onQuestions={openQuestions}
            onNewSpace={newSpace}
            menu={menu}
          />
        ),
      }}
    />
  );
}
