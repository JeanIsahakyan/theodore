/**
 * Web (and the type every platform shares): a device as a row of the
 * Devices `Form`, in React Native. iOS and Android draw it natively
 * (`DeviceItem.ios.tsx`, `DeviceItem.android.tsx`).
 */
import { StyleSheet, Text, View } from 'react-native';
import type { DeviceItemProps, FingerprintItemProps } from './deviceView';
import { fingerprintLabel } from './deviceView';
import { Badge, Dot } from './kit';
import { kindIcon } from './native/icons';
import { webStyles } from './native/rnStyles';
import { WebIcon } from './native/webIcons';
import { mono, usePalette } from './theme';

export function DeviceItem({
  name,
  kind,
  online,
  detail,
  fingerprint,
  trusted,
  agents,
}: DeviceItemProps) {
  const p = usePalette();
  return (
    <View style={[webStyles.slot, styles.item]}>
      <View style={styles.icon}>
        <WebIcon name={kindIcon(kind)} color={p.accent} size={24} />
      </View>
      <View style={styles.flex}>
        <View style={styles.nameRow}>
          <Text numberOfLines={1} style={[styles.name, { color: p.text }]}>
            {name}
          </Text>
          <Dot on={online} label={online ? 'Online' : 'Offline'} />
          <View style={styles.flex} />
          {trusted ? <Badge label="Trusted" tone="success" /> : null}
        </View>
        <Text style={[webStyles.rowDetail, { color: p.muted }]}>{detail}</Text>
        {agents ? (
          <Text
            accessibilityLabel={`Agents: ${agents}`}
            style={[styles.agents, { color: p.muted }]}
          >
            {agents}
          </Text>
        ) : null}
        <Text
          selectable
          accessibilityLabel={fingerprintLabel(fingerprint)}
          style={[mono, styles.fingerprint, { color: p.text }]}
        >
          {fingerprint || '—'}
        </Text>
      </View>
    </View>
  );
}

export function FingerprintItem({
  value,
  label,
  size = 'regular',
}: FingerprintItemProps) {
  const p = usePalette();
  return (
    <View style={[webStyles.slot, styles.item]}>
      {label ? (
        <View style={styles.icon}>
          <WebIcon name="fingerprint" color={p.text} />
        </View>
      ) : null}
      <View style={styles.flex}>
        {label ? (
          <Text style={[webStyles.rowLabel, { color: p.text }]}>{label}</Text>
        ) : null}
        <Text
          selectable
          accessibilityLabel={fingerprintLabel(value)}
          style={[
            mono,
            size === 'large' ? styles.large : styles.regular,
            { color: label ? p.muted : p.text },
          ]}
        >
          {value || '—'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  item: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  icon: { paddingTop: 2 },
  flex: { flex: 1, gap: 3 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { flexShrink: 1, fontSize: 17, fontWeight: '600' },
  agents: { fontSize: 12 },
  fingerprint: { fontSize: 13, lineHeight: 18 },
  regular: { fontSize: 15, lineHeight: 21 },
  large: { fontSize: 20, lineHeight: 28 },
});
