// Adapted from EvanBacon/chat-template (MIT)
/**
 * iOS: bar button items on the native navigation bar (Liquid Glass on
 * iOS 26+, the classic bar before). Rendered by a screen that is a root
 * of the shell (Home).
 *
 * ```text
 * [☰]          New space          [🔔][✎]
 * ```
 */
import { Stack } from 'expo-router';
import { liquidGlass } from '../ui/native';
import { usePalette } from '../ui/theme';
import { useHeaderActions, type MainHeaderProps } from './header-actions';

export function MainHeader({ title, onNewSpace }: MainHeaderProps) {
  const p = usePalette();
  const { openDrawer, newSpace, waiting, openQuestions } =
    useHeaderActions(onNewSpace);
  return (
    <>
      <Stack.Screen options={{ title }} />
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
      </Stack.Toolbar>
    </>
  );
}
