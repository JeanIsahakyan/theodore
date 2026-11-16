// Adapted from EvanBacon/chat-template (MIT)
/**
 * A pushed chat screen's title: the name on one line, cut with "…", and a
 * muted line under it ("on mac-A · Running"). `TitleStack` is the two
 * lines alone (inside the iOS 26 native bar); `TitleBar` is a whole bar
 * with Back (iOS before 26, web), the kit `TopBar`'s look.
 *
 * ```text
 * iOS   [‹ Back]     fix the login bug…      [   ]   centered, sides equal
 *                    on mac-A · Running
 * web   [‹ Back]  fix the login bug…
 *                 on mac-A · Running
 * ```
 */
import { Platform, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePalette } from '../ui/theme';

export interface SpaceHeaderProps {
  title: string;
  subtitle: string;
}

const centered = Platform.OS === 'ios';

export function TitleStack({
  title,
  subtitle,
  maxWidth,
  align = 'center',
}: SpaceHeaderProps & { maxWidth?: number; align?: 'center' | 'start' }) {
  const p = usePalette();
  const items = align === 'center' ? 'items-center' : 'items-start';
  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={`${title}, ${subtitle}`}
      className={`min-w-0 ${items}`}
      style={maxWidth ? { maxWidth } : null}
    >
      <Text
        numberOfLines={1}
        style={{
          color: p.text,
          fontSize: centered ? 17 : 18,
          fontWeight: centered ? '600' : '500',
        }}
      >
        {title}
      </Text>
      <Text numberOfLines={1} style={{ color: p.muted, fontSize: 12 }}>
        {subtitle}
      </Text>
    </View>
  );
}

export function TitleBar({
  title,
  subtitle,
  onBack,
}: SpaceHeaderProps & { onBack: () => void }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const side = centered ? 'w-24' : '';
  return (
    <View
      style={{
        paddingTop: insets.top,
        paddingLeft: insets.left,
        paddingRight: insets.right,
        backgroundColor: p.surface,
        borderBottomColor: p.border,
        borderBottomWidth: 0.5,
      }}
    >
      <View
        className="flex-row items-center"
        style={{ height: centered ? 48 : 60 }}
      >
        <View className={side}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={12}
            onPress={onBack}
            className="px-4 py-2 active:opacity-60"
          >
            <Text numberOfLines={1} style={{ color: p.accent, fontSize: 17 }}>
              ‹ Back
            </Text>
          </Pressable>
        </View>
        <View
          className={`min-w-0 flex-1 ${centered ? 'items-center' : 'items-start pr-4'}`}
        >
          <TitleStack
            title={title}
            subtitle={subtitle}
            align={centered ? 'center' : 'start'}
          />
        </View>
        {centered ? <View className={side} /> : null}
      </View>
    </View>
  );
}
