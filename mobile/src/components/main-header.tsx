// Adapted from EvanBacon/chat-template (MIT)
/**
 * Web: the JS stack's header with the menu (narrow windows only: wide ones
 * keep the sidebar open), the questions bell and "new space".
 *
 * ```text
 * [☰]  New space                       [🔔 3][✎]
 * ```
 */
import { Stack } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { usePalette } from '../ui/theme';
import { useHeaderActions, type MainHeaderProps } from './header-actions';
import { SymbolImage, type SymbolName } from './symbol-image';

function HeaderButton({
  icon,
  label,
  onPress,
  color,
  count,
  className = '',
}: {
  icon: SymbolName;
  label: string;
  onPress: () => void;
  color: string;
  count?: number;
  className?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      className={`h-9 flex-row items-center gap-1 rounded-lg px-2 hover:bg-accent active:bg-accent ${className}`}
    >
      <SymbolImage name={icon} size={18} color={color} />
      {count ? (
        <Text className="text-[13px] font-semibold text-warning">{count}</Text>
      ) : null}
    </Pressable>
  );
}

export function MainHeader({ title, onNewSpace }: MainHeaderProps) {
  const p = usePalette();
  const { openDrawer, newSpace, waiting, openQuestions } =
    useHeaderActions(onNewSpace);
  return (
    <Stack.Screen
      options={{
        title,
        headerShadowVisible: false,
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
          <View className="mr-2 flex-row items-center gap-1">
            {waiting > 0 ? (
              <HeaderButton
                icon="bell"
                label={`${waiting} question${waiting === 1 ? '' : 's'} waiting`}
                onPress={openQuestions}
                color={p.warning}
                count={waiting}
              />
            ) : null}
            <HeaderButton
              icon="compose"
              label="New space"
              onPress={newSpace}
              color={p.text}
            />
          </View>
        ),
      }}
    />
  );
}
