/**
 * Devices: this phone's fingerprint (to show on your computer so it can trust
 * this phone), and every other device with trust / untrust, as one grouped
 * native `Form` (docs/mobile.md "Native UI"):
 *
 * ```text
 * This device     fingerprint, large
 * Your devices    one section per device:
 *                   name ● · kind · OS · online · max mode · fingerprint · Trusted
 *                   Trust ─▶ fingerprint confirm ─▶ trusted   | Untrust
 *                   (a failed trust / untrust is said under its section)
 * ```
 */
import { useMemo } from 'react';
import { View } from 'react-native';
import type { FleetDeviceView } from '../../../src/fleet/types';
import { useFleetState } from '../../../src/state/fleet';
import { ConnectionBanner } from '../../../src/ui/ConnectionBanner';
import { DeviceItem, FingerprintItem } from '../../../src/ui/DeviceItem';
import { deviceDetail } from '../../../src/ui/deviceView';
import { sortDevices } from '../../../src/ui/logic';
import { Button, Form, Row, Section } from '../../../src/ui/native';
import { usePalette } from '../../../src/ui/theme';
import { useTrust } from '../../../src/ui/TrustConfirm';

function DeviceSection({
  device,
  title,
}: {
  device: FleetDeviceView;
  title?: string;
}) {
  const { trust, untrust, busy, error } = useTrust(device);
  return (
    <Section title={title} footer={error ?? undefined}>
      <DeviceItem
        name={device.name}
        kind={device.kind}
        online={device.online}
        detail={deviceDetail(device)}
        fingerprint={device.fingerprint}
        trusted={device.trusted}
      />
      {device.trusted ? (
        <Button
          label="Untrust"
          variant="destructive"
          loading={busy}
          accessibilityLabel={`Untrust ${device.name}`}
          onPress={untrust}
        />
      ) : (
        <Button
          label="Trust"
          variant="primary"
          loading={busy}
          accessibilityLabel={`Trust ${device.name}`}
          onPress={() => void trust()}
        />
      )}
    </Section>
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
    <View style={{ flex: 1, backgroundColor: p.background }}>
      <ConnectionBanner />
      <Form testID="devices">
        <Section
          title="This device"
          footer="Show this on your computer to trust this phone."
        >
          <FingerprintItem value={fingerprint} />
        </Section>

        {devices.length === 0 ? (
          <Section
            title="Your devices"
            footer="Open Theodore on a computer signed in to the same account."
          >
            <Row label="No other devices yet" />
          </Section>
        ) : (
          devices.map((d, i) => (
            <DeviceSection
              key={d.deviceId}
              device={d}
              title={i === 0 ? 'Your devices' : undefined}
            />
          ))
        )}
      </Form>
    </View>
  );
}
