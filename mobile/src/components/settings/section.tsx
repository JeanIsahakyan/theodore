// Adapted from EvanBacon/chat-template (MIT)
/**
 * The pieces around settings rows, the template's flat page:
 *
 * ```text
 * SettingsScroll   the page: scrolls, background, under a glass header on
 *                  iOS 26+ (automatic insets), the safe area at the bottom
 * SectionHeader    "Computers"     iOS / web: 15 semibold; Android: Material 3
 *                                  list subheader (14 sp, primary)
 * SectionDivider   ──────────      1 px, inset like the rows
 * SectionNote      a muted line under rows; `danger` for an error
 * ```
 */
import type { ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const android = process.env.EXPO_OS === 'android';

export function SettingsScroll({
  children,
  testID,
}: {
  children: ReactNode;
  testID?: string;
}) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      testID={testID}
      className="flex-1 bg-background"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
    >
      {children}
    </ScrollView>
  );
}

export function SectionDivider() {
  return (
    <View
      className={
        android ? 'mx-4 my-2 h-px bg-border' : 'mx-5 my-2 h-px bg-border'
      }
    />
  );
}

export function SectionHeader({
  title,
  trailing,
}: {
  title: string;
  /** A muted note on the right ("2 of 3 online"). */
  trailing?: string;
}) {
  return (
    <View
      accessibilityRole="header"
      className={
        android
          ? 'flex-row items-baseline justify-between px-4 pt-5 pb-2'
          : 'flex-row items-baseline justify-between px-5 pt-6 pb-2'
      }
    >
      <Text
        className={
          android
            ? 'text-sm font-medium text-primary'
            : 'text-[15px] font-semibold text-foreground'
        }
      >
        {title}
      </Text>
      {trailing ? (
        <Text className="text-[13px] text-muted-foreground">{trailing}</Text>
      ) : null}
    </View>
  );
}

export function SectionNote({
  children,
  danger,
}: {
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <Text
      accessibilityLiveRegion={danger ? 'polite' : undefined}
      className={`${android ? 'px-4' : 'px-5'} pt-1 pb-3 text-[13px] leading-snug ${danger ? 'text-danger' : 'text-muted-foreground'}`}
    >
      {children}
    </Text>
  );
}
