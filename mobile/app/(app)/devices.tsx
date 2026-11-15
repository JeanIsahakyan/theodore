/**
 * Devices: this phone's fingerprint (to show on your computer so it can trust
 * this phone), and every device with trust / untrust. Trusting always goes
 * through the fingerprint confirm.
 */
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useServices } from '../../src/services';
import { useFleetState } from '../../src/state/fleet';
import type { FleetDeviceView } from '../../src/fleet/types';
import { ConnectionBanner } from '../../src/ui/ConnectionBanner';
import {
  Badge,
  Button,
  Card,
  Dot,
  Empty,
  Fingerprint,
  Notice,
  SectionTitle,
} from '../../src/ui/kit';
import {
  MODE_LABEL,
  errorText,
  kindGlyph,
  kindLabel,
  sortDevices,
} from '../../src/ui/logic';
import { TrustConfirm } from '../../src/ui/TrustConfirm';
import { usePalette } from '../../src/ui/theme';

function DeviceRow({ device }: { device: FleetDeviceView }) {
  const { fleet } = useServices();
  const p = usePalette();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const untrust = () => {
    setBusy(true);
    setError(null);
    fleet
      .untrust(device.deviceId)
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };

  return (
    <Card>
      <View style={styles.top}>
        <Text accessible={false} style={styles.glyph}>
          {kindGlyph(device.kind)}
        </Text>
        <View style={styles.flex}>
          <View style={styles.nameRow}>
            <Text numberOfLines={1} style={[styles.name, { color: p.text }]}>
              {device.name}
            </Text>
            <Dot
              on={device.online}
              label={device.online ? 'Online' : 'Offline'}
            />
          </View>
          <Text style={[styles.meta, { color: p.muted }]}>
            {kindLabel(device.kind)} · {device.os} ·{' '}
            {device.online ? 'online' : 'offline'}
            {device.acceptsRemote
              ? ` · runs spaces up to ${MODE_LABEL[device.maxMode]}`
              : ''}
          </Text>
        </View>
        {device.trusted ? <Badge label="Trusted" tone="success" /> : null}
      </View>
      <Fingerprint value={device.fingerprint} />
      {device.thisDevice ? null : device.trusted ? (
        <View style={styles.actions}>
          <Button
            label="Untrust"
            kind="secondary"
            busy={busy}
            onPress={untrust}
          />
        </View>
      ) : confirming ? (
        <TrustConfirm
          device={device}
          onCancel={() => setConfirming(false)}
          onTrusted={() => setConfirming(false)}
        />
      ) : (
        <View style={styles.actions}>
          <Button
            label="Trust"
            kind="primary"
            accessibilityLabel={`Trust ${device.name}`}
            onPress={() => setConfirming(true)}
          />
        </View>
      )}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Card>
  );
}

export default function DevicesScreen() {
  const p = usePalette();
  const fingerprint = useFleetState((s) => s.fingerprint);
  const allDevices = useFleetState((s) => s.devices);
  const devices = useMemo(
    () => sortDevices(allDevices.filter((d) => !d.thisDevice)),
    [allDevices],
  );

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
    >
      <ConnectionBanner />
      <SectionTitle>This device</SectionTitle>
      <Card>
        <Fingerprint value={fingerprint} large />
        <Text style={[styles.meta, { color: p.muted }]}>
          Show this on your computer to trust this phone.
        </Text>
      </Card>

      <SectionTitle>Your devices</SectionTitle>
      {devices.length === 0 ? (
        <Empty
          title="No other devices yet"
          hint="Open Theodore on a computer signed in to the same account."
        />
      ) : (
        devices.map((d) => <DeviceRow key={d.deviceId} device={d} />)
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12 },
  flex: { flex: 1, gap: 2 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  glyph: { fontSize: 26 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { flexShrink: 1, fontSize: 17, fontWeight: '600' },
  meta: { fontSize: 13 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end' },
});
