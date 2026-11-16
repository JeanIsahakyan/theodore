// Adapted from EvanBacon/chat-template (MIT)
/**
 * Devices: this phone's fingerprint (to show on your computer so it can trust
 * this phone), and every other device with trust / untrust, as one grouped
 * native `Form` (docs/mobile.md "Native UI"):
 *
 * ```text
 * This device           [icon] name · status; fingerprint, large
 * Computers             one section per device, online first, then by name:
 *                         [icon] name ● · kind · OS · online · max mode   ✓ Trusted
 *                                agents it offers ("Claude · Codex")
 *                                fingerprint
 *                         Trust ─▶ fingerprint confirm ─▶ trusted   | Untrust
 *                         (a failed trust / untrust is said under its section)
 * Phones and browsers   the same
 * ```
 */
import { useMemo } from 'react';
import { View } from 'react-native';
import type { FleetDeviceView } from '../../src/fleet/types';
import { useGlassHeaderInset } from '../../src/shell/glassHeader';
import { useFleetState } from '../../src/state/fleet';
import { ConnectionBanner } from '../../src/ui/ConnectionBanner';
import { DeviceItem, FingerprintItem } from '../../src/ui/DeviceItem';
import {
  CONNECTION_LABEL,
  agentsLine,
  deviceDetail,
  groupDevices,
} from '../../src/ui/deviceView';
import { Button, Form, Row, Section } from '../../src/ui/native';
import { kindIcon } from '../../src/ui/native/icons';
import { usePalette } from '../../src/ui/theme';
import { useTrust } from '../../src/ui/TrustConfirm';

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
        agents={agentsLine(device.agents)}
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
  // iOS 26+: the glass header overlays the screen; the form insets itself.
  const top = useGlassHeaderInset();
  const fingerprint = useFleetState((s) => s.fingerprint);
  const connection = useFleetState((s) => s.connection);
  const allDevices = useFleetState((s) => s.devices);
  const me = useMemo(() => allDevices.find((d) => d.thisDevice), [allDevices]);
  const groups = useMemo(
    () => groupDevices(allDevices.filter((d) => !d.thisDevice)),
    [allDevices],
  );

  return (
    <View style={{ flex: 1, backgroundColor: p.background }}>
      <ConnectionBanner style={top ? { marginTop: top } : null} />
      <Form testID="devices">
        <Section
          title="This device"
          footer="Show this fingerprint on your computer to trust this device there."
        >
          <Row
            icon={kindIcon(me?.kind ?? 'mobile')}
            label={me?.name || 'This device'}
            value={CONNECTION_LABEL[connection]}
          />
          <FingerprintItem value={fingerprint} size="large" />
        </Section>

        {groups.length === 0 ? (
          <Section
            title="Your devices"
            footer="Open Theodore on a computer signed in to the same account."
          >
            <Row label="No other devices yet" />
          </Section>
        ) : (
          groups.flatMap((g) =>
            g.devices.map((d, i) => (
              <DeviceSection
                key={d.deviceId}
                device={d}
                title={i === 0 ? g.title : undefined}
              />
            )),
          )
        )}
      </Form>
    </View>
  );
}
