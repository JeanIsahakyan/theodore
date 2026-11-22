// Adapted from EvanBacon/chat-template (MIT)
/**
 * iOS: bar button items on the native navigation bar (Liquid Glass on
 * iOS 26+, the classic bar before). Rendered by the shell's top-level
 * screens: Home and a space (no Back: the drawer is how you leave it).
 *
 * ```text
 * [☰]          New space          [🔔][✎]
 * [☰]      fix the login bug…     [🔔][✎][⌸]   a space: two lines, then
 *          on mac-A · Running                  its `actions` (Archive)
 * ```
 */
import { Stack } from 'expo-router';
import { useWindowDimensions } from 'react-native';
import { liquidGlass } from '../ui/native';
import { usePalette } from '../ui/theme';
import { useHeaderActions, type MainHeaderProps } from './header-actions';
import { TitleStack } from './space-title';
import { SYMBOLS } from './symbol-image';

/** Room left for the bar's items on both sides. */
const SIDES = 150;

export function MainHeader({
  title,
  subtitle,
  onNewSpace,
  actions,
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
        {actions?.map((a) => (
          <Stack.Toolbar.Button
            key={a.label}
            icon={SYMBOLS[a.icon].sf}
            accessibilityLabel={a.label}
            tintColor={a.destructive ? p.danger : p.text}
            onPress={a.onPress}
          />
        ))}
      </Stack.Toolbar>
    </>
  );
}
