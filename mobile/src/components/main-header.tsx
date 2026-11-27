// Adapted from EvanBacon/chat-template (MIT)
/**
 * Web: the JS stack's header with the menu (narrow windows only: wide ones
 * keep the sidebar open) and "new space".
 *
 * ```text
 * [☰]  New space                            [✎]
 * [☰]  fix the login bug…                   [✎]   a space: two lines
 *      on mac-A · Running
 * ```
 */
import { Stack } from 'expo-router';
import { Pressable } from 'react-native';
import { usePalette } from '../ui/theme';
import { useHeaderActions, type MainHeaderProps } from './header-actions';
import { TitleStack } from './space-title';
import { SymbolImage, type SymbolName } from './symbol-image';

function HeaderButton({
  icon,
  label,
  onPress,
  color,
  className = '',
}: {
  icon: SymbolName;
  label: string;
  onPress: () => void;
  color: string;
  className?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      className={`h-9 flex-row items-center rounded-lg px-2 hover:bg-accent active:bg-accent ${className}`}
    >
      <SymbolImage name={icon} size={18} color={color} />
    </Pressable>
  );
}

export function MainHeader({ title, subtitle, onNewSpace }: MainHeaderProps) {
  const p = usePalette();
  const { openDrawer, newSpace } = useHeaderActions(onNewSpace);
  return (
    <Stack.Screen
      options={{
        title,
        headerShadowVisible: false,
        ...(subtitle
          ? {
              headerTitle: () => (
                <TitleStack title={title} subtitle={subtitle} align="start" />
              ),
            }
          : null),
        headerLeft: () => (
          <HeaderButton
            icon="menu"
            label="Open menu"
            onPress={openDrawer}
            color={p.text}
            className="ml-2 md:hidden"
          />
        ),
        headerRight: () => (
          <HeaderButton
            icon="compose"
            label="New space"
            onPress={newSpace}
            color={p.text}
            className="mr-2"
          />
        ),
      }}
    />
  );
}
