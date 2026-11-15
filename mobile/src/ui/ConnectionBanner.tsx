/**
 * A quiet capsule under the header: "Connecting to your devices…" with a
 * spinner once the fleet has been reconnecting for a while
 * (`./connection.ts`), or why it is not connected. Nothing otherwise.
 */
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useFleetState } from '../state/fleet';
import { connectionBanner, lateConnecting } from './connection';
import { usePalette } from './theme';

export function ConnectionBanner() {
  const p = usePalette();
  const connection = useFleetState((s) => s.connection);
  const error = useFleetState((s) => s.error);
  const [late, setLate] = useState(false);

  useEffect(() => {
    const watch = lateConnecting(setLate);
    watch.update(useFleetState.getState().connection);
    const off = useFleetState.subscribe((s) => watch.update(s.connection));
    return () => {
      off();
      watch.dispose();
    };
  }, []);

  const view = connectionBanner(connection, error, late);
  if (!view) return null;
  const danger = view.tone === 'danger';
  return (
    <View
      accessible
      accessibilityRole={danger ? 'alert' : undefined}
      accessibilityLabel={view.text}
      accessibilityLiveRegion="polite"
      style={[styles.pill, { backgroundColor: p.surfaceMuted }]}
    >
      {view.busy ? <ActivityIndicator size="small" color={p.muted} /> : null}
      <Text
        selectable={danger}
        style={[styles.text, { color: danger ? p.danger : p.muted }]}
      >
        {view.text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'center',
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
  },
  text: { fontSize: 13, fontWeight: '500', textAlign: 'center', flexShrink: 1 },
});
