/**
 * The pushed-screen header (`PushedHeader`) with an action on the trailing
 * side: a form's "Start" stays reachable while the keyboard is up, like a
 * navigation bar's confirm button / a Material top app bar action.
 * `PushedHeader` has no trailing slot yet, so this one is local.
 *
 * ```text
 * iOS            [‹ Back][   title, centered…   ][action]   sides equal
 * Android, web   [‹ Back][title, left-aligned…     ][action]
 * ```
 */
import { useState, type ReactNode } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BackButton } from '../../shell/PushedHeader';
import { usePalette } from '../theme';

const centered = Platform.OS === 'ios';

export function ActionHeader({
  title,
  action,
}: {
  title: string;
  action?: ReactNode;
}) {
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
            <BackButton color={p.accent} />
          </View>
        </View>
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          style={[
            styles.title,
            centered ? styles.center : action ? null : styles.start,
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
    height: Platform.select({ ios: 44, android: 56, default: 64 }),
    flexDirection: 'row',
    alignItems: 'center',
  },
  side: { flexShrink: 0 },
  trailing: { alignItems: 'flex-end' },
  action: { paddingHorizontal: Platform.select({ android: 4, default: 8 }) },
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: Platform.select({ ios: 17, android: 20, default: 18 }),
    fontWeight: Platform.select({ ios: '600', default: '500' }),
  },
  center: { textAlign: 'center' },
  start: { paddingRight: 16 },
});
