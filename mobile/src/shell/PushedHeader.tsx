/**
 * The header of a screen pushed over the tabs (a space, Start a space):
 * "‹ Back" and the title on one line. The back button never shrinks; a long
 * title is cut with an ellipsis instead. Same on iOS, Android and web.
 *
 * ```text
 * iOS            [‹ Back][     title, centered…     ][spacer = back]
 * Android, web   [‹ Back][title, left-aligned…                     ]
 * ```
 */
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePalette } from '../ui/theme';

const centered = Platform.OS === 'ios';

export function BackButton({ color }: { color: string }) {
  const back = () =>
    router.canGoBack() ? router.back() : router.replace('/' as Href);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Back"
      hitSlop={12}
      onPress={back}
      style={styles.back}
    >
      <Text numberOfLines={1} style={[styles.backText, { color }]}>
        ‹ Back
      </Text>
    </Pressable>
  );
}

export function PushedHeader({ title }: { title: string }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const [side, setSide] = useState(0);
  return (
    <View
      style={[
        styles.bar,
        {
          paddingTop: insets.top,
          paddingLeft: insets.left,
          paddingRight: insets.right,
          backgroundColor: p.surface,
          borderBottomColor: p.border,
        },
      ]}
    >
      <View style={styles.row}>
        <View
          style={styles.side}
          onLayout={(e) => setSide(e.nativeEvent.layout.width)}
        >
          <BackButton color={p.accent} />
        </View>
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          style={[
            styles.title,
            centered ? styles.center : styles.start,
            { color: p.text },
          ]}
        >
          {title}
        </Text>
        {centered ? <View style={[styles.side, { width: side }]} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { borderBottomWidth: StyleSheet.hairlineWidth },
  row: {
    height: Platform.select({ ios: 44, android: 56, default: 64 }),
    flexDirection: 'row',
    alignItems: 'center',
  },
  side: { flexShrink: 0 },
  back: { flexShrink: 0, paddingHorizontal: 16, paddingVertical: 8 },
  backText: { fontSize: 17 },
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: Platform.select({ ios: 17, android: 20, default: 18 }),
    fontWeight: Platform.select({ ios: '600', default: '500' }),
  },
  center: { textAlign: 'center' },
  start: { paddingRight: 16 },
});
