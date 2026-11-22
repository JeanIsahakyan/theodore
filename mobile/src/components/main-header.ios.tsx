// Adapted from EvanBacon/chat-template (MIT)
/**
 * iOS: bar button items on the native navigation bar (Liquid Glass on
 * iOS 26+, the classic bar before). Rendered by the shell's top-level
 * screens: Home and a space (no Back: the drawer is how you leave it).
 *
 * ```text
 * [☰]          New space          [🔔][✎]
 * [☰]      fix the login bug…     [🔔][✎][⋯]   a space: two lines, ⋯ a
 *          on mac-A · Running                  UIMenu with `menu` items
 * ```
 */
import { Stack } from 'expo-router';
import { useWindowDimensions } from 'react-native';
import { liquidGlass } from '../ui/native';
import { usePalette } from '../ui/theme';
import { useHeaderActions, type MainHeaderProps } from './header-actions';
import { TitleStack } from './space-title';

/** Room left for the bar's items on both sides. */
const SIDES = 150;

export function MainHeader({
  title,
  subtitle,
  onNewSpace,
  menu,
}: MainHeaderProps) {
  const p = usePalette();
  const { width } = useWindowDimensions();
  const { openDrawer, newSpace, waiting, openQuestions } =
    useHeaderActions(onNewSpace);
  return (
    <>
      <Stack.Screen
        options={{
          title,
          headerBackVisible: false,
          ...(subtitle
            ? {
                headerTitle: () => (
                  <TitleStack
                    title={title}
                    subtitle={subtitle}
                    maxWidth={Math.max(120, width - SIDES)}
                  />
                ),
              }
            : null),
        }}
      />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button
          icon="line.3.horizontal"
          accessibilityLabel="Open menu"
          tintColor={p.text}
          onPress={openDrawer}
        />
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        {waiting > 0 ? (
          <Stack.Toolbar.Button
            icon="bell.badge"
            accessibilityLabel={`${waiting} question${waiting === 1 ? '' : 's'} waiting`}
            tintColor={p.warning}
            {...(liquidGlass ? { badge: { value: waiting } } : null)}
            onPress={openQuestions}
          />
        ) : null}
        <Stack.Toolbar.Button
          icon="square.and.pencil"
          accessibilityLabel="New space"
          tintColor={p.text}
          onPress={newSpace}
        />
        {menu?.length ? (
          <Stack.Toolbar.Menu
            icon="ellipsis.circle"
            accessibilityLabel="More"
            tintColor={p.text}
          >
            {menu.map((it) => (
              <Stack.Toolbar.MenuAction
                key={it.label}
                destructive={it.destructive}
                onPress={it.onPress}
              >
                {it.label}
              </Stack.Toolbar.MenuAction>
            ))}
          </Stack.Toolbar.Menu>
        ) : null}
      </Stack.Toolbar>
    </>
  );
}
