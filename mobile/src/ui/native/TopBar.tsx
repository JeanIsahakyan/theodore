/**
 * The bar of a pushed screen: "‹ Back", the title, one trailing action. The
 * back button never shrinks; a long title ends in "…". iOS (before 26) and
 * web; Android draws a Material 3 top app bar (`TopBar.android.tsx`); iOS
 * 26+ screens use the native glass navigation bar instead (see
 * `src/shell/glassHeader.ts`).
 *
 * ```text
 * iOS   [‹ Back][   title, centered…   ][action]   sides equal
 * web   [‹ Back][title, left-aligned…     ][action]
 * ```
 */
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePalette } from '../theme';
import type { TopBarProps } from './types';

const centered = Platform.OS === 'ios';

export function TopBar({ title, onBack, action }: TopBarProps) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const [lead, setLead] = useState(0);
  const [trail, setTrail] = useState(0);
  const side = centered ? Math.max(lead, action ? trail : 0) : undefined;
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
        <View style={[styles.side, { minWidth: side }]}>
          <View onLayout={(e) => setLead(e.nativeEvent.layout.width)}>
            {onBack ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Back"
                hitSlop={12}
                onPress={onBack}
                style={styles.back}
              >
                <Text
                  numberOfLines={1}
                  style={[styles.backText, { color: p.accent }]}
                >
                  ‹ Back
                </Text>
              </Pressable>
            ) : null}
          </View>
        </View>
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          style={[
            styles.title,
            centered ? styles.center : action ? null : styles.start,
            !onBack && !centered ? styles.alone : null,
            { color: p.text },
          ]}
        >
          {title}
        </Text>
        {action || centered ? (
          <View style={[styles.side, styles.trailing, { minWidth: side }]}>
            {action ? (
              <View
                style={styles.action}
                onLayout={(e) => setTrail(e.nativeEvent.layout.width)}
              >
                {action}
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { borderBottomWidth: StyleSheet.hairlineWidth },
  row: {
    height: Platform.select({ ios: 44, default: 64 }),
    flexDirection: 'row',
    alignItems: 'center',
  },
  side: { flexShrink: 0 },
  trailing: { alignItems: 'flex-end' },
  back: { flexShrink: 0, paddingHorizontal: 16, paddingVertical: 8 },
  backText: { fontSize: 17 },
  action: { paddingHorizontal: 8 },
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: Platform.select({ ios: 17, default: 18 }),
    fontWeight: Platform.select({ ios: '600', default: '500' }),
  },
  center: { textAlign: 'center' },
  start: { paddingRight: 16 },
  alone: { paddingLeft: 16 },
});
