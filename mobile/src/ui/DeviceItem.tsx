/**
 * Web (and the type every platform shares): a device as a row of the
 * Devices `Form`, in React Native. iOS and Android draw it natively
 * (`DeviceItem.ios.tsx`, `DeviceItem.android.tsx`).
 */
import { StyleSheet, Text, View } from 'react-native';
import type { DeviceItemProps, FingerprintItemProps } from './deviceView';
import { Badge, Dot, Fingerprint } from './kit';
import { kindGlyph } from './logic';
import { webStyles } from './native/rnStyles';
import { usePalette } from './theme';

export function DeviceItem({
  name,
  kind,
  online,
  detail,
  fingerprint,
  trusted,
}: DeviceItemProps) {
  const p = usePalette();
  return (
    <View style={[webStyles.slot, styles.item]}>
      <View style={styles.top}>
        <Text accessible={false} style={styles.glyph}>
          {kindGlyph(kind)}
        </Text>
        <View style={styles.flex}>
          <View style={styles.nameRow}>
            <Text numberOfLines={1} style={[styles.name, { color: p.text }]}>
              {name}
            </Text>
            <Dot on={online} label={online ? 'Online' : 'Offline'} />
          </View>
          <Text style={[webStyles.rowDetail, { color: p.muted }]}>
            {detail}
          </Text>
        </View>
        {trusted ? <Badge label="Trusted" tone="success" /> : null}
      </View>
      <Fingerprint value={fingerprint} />
    </View>
  );
}

export function FingerprintItem({ value }: FingerprintItemProps) {
  return (
    <View style={webStyles.slot}>
      <Fingerprint value={value} large />
    </View>
  );
}

const styles = StyleSheet.create({
  item: { gap: 8 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  glyph: { fontSize: 26 },
  flex: { flex: 1, gap: 2 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { flexShrink: 1, fontSize: 17, fontWeight: '600' },
});
