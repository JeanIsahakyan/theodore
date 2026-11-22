/**
 * A quiet capsule under the header: "Connecting to your devices…" with a
 * spinner once the fleet has been reconnecting for a while
 * (`./connection.ts`), or why it is not connected. Nothing otherwise.
 *
 * The capsule is the kit's `Glass`: Liquid Glass on iOS 26+, a muted pill
 * elsewhere (Material You's surface on Android 12+). `style` places it
 * (e.g. below a glass header).
 */
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useAccountSwitch } from '../state/accounts';
import { useFleetState } from '../state/fleet';
import { connectionBanner, lateConnecting } from './connection';
import { Glass } from './native';
import { usePalette } from './theme';

export function ConnectionBanner({ style }: { style?: StyleProp<ViewStyle> }) {
  const p = usePalette();
  const connection = useFleetState((s) => s.connection);
  const error = useFleetState((s) => s.error);
  const switching = useAccountSwitch((s) => s.switching);
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

  const view = connectionBanner(connection, error, late, switching);
  if (!view) return null;
  const danger = view.tone === 'danger';
  return (
    <Glass
      shape="capsule"
      fallback="muted"
      accessible
      accessibilityRole={danger ? 'alert' : undefined}
      accessibilityLabel={view.text}
      accessibilityLiveRegion="polite"
      style={[styles.pill, style]}
    >
      {view.busy ? <ActivityIndicator size="small" color={p.muted} /> : null}
      <Text
        selectable={danger}
        style={[styles.text, { color: danger ? p.danger : p.muted }]}
      >
        {view.text}
      </Text>
    </Glass>
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
  },
  text: { fontSize: 13, fontWeight: '500', textAlign: 'center', flexShrink: 1 },
});
