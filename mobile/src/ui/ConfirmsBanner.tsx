/**
 * Requests from Claude via the cloud waiting on a computer for Allow /
 * Deny (`ConfirmCard`): the one kind of waiting that has no chat to show
 * it in. Home mounts it under its header; it renders nothing when there is
 * none. A question of a space is not here: its chat shows it.
 *
 * ```text
 * ALLOW CLAUDE? · 2            a grouped-list section title (iOS, web) /
 * ┌ confirm card ──────────┐   a Material label in the accent (Android)
 * └────────────────────────┘
 * <a confirm's refusal>  Dismiss
 * ```
 *
 * `glass`: the cards are Liquid Glass on iOS 26+. `top`: room for a header
 * that overlays it (`useGlassHeaderInset`), only while it shows.
 */
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useFleetState } from '../state/fleet';
import { ConfirmCard } from './ConfirmCard';
import { Notice } from './kit';
import { errorText } from './logic';
import { Button } from './native';
import { usePalette } from './theme';

const android = process.env.EXPO_OS === 'android';

export function ConfirmsBanner({
  top = 0,
  glass,
}: {
  top?: number;
  glass?: boolean;
}) {
  const p = usePalette();
  const confirms = useFleetState((s) => s.confirms);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  if (confirms.length === 0 && !confirmError) return null;
  const count = confirms.length;
  const title = android ? 'Allow Claude?' : 'ALLOW CLAUDE?';
  return (
    <View
      style={[
        styles.wrap,
        { backgroundColor: p.background },
        top ? { paddingTop: styles.wrap.paddingTop + top } : null,
      ]}
      accessibilityLabel="Requests waiting for Allow or Deny"
    >
      <Text
        accessibilityRole="header"
        style={[
          android ? styles.titleAndroid : styles.titleIos,
          { color: android ? p.accent : p.muted },
        ]}
      >
        {count > 1 ? `${title} · ${count}` : title}
      </Text>
      {confirms.map((c) => (
        <ConfirmCard
          key={c.confirmId}
          confirm={c}
          glass={glass}
          onError={(e) => setConfirmError(errorText(e))}
        />
      ))}
      {confirmError ? (
        <View style={styles.error}>
          <Notice tone="danger">{confirmError}</Notice>
          <Button
            variant="plain"
            label="Dismiss"
            onPress={() => setConfirmError(null)}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 },
  titleIos: { fontSize: 13, letterSpacing: 0.2, paddingHorizontal: 4 },
  titleAndroid: { fontSize: 14, fontWeight: '500', paddingHorizontal: 4 },
  error: { gap: 4, alignItems: 'center' },
});
