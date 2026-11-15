/**
 * Trusting a device (docs/fleet.md "Trust"): its fingerprint in full, to
 * compare with what that device shows for itself, then the button that pins
 * it. The key sent is the one this fingerprint is of.
 */
import { useState } from 'react';
import { Text } from 'react-native';
import { useServices } from '../services';
import type { FleetDeviceView } from '../fleet/types';
import { Confirm, Fingerprint, Notice } from './kit';
import { errorText } from './logic';
import { usePalette } from './theme';

export function TrustConfirm({
  device,
  onCancel,
  onTrusted,
}: {
  device: Pick<
    FleetDeviceView,
    'deviceId' | 'name' | 'fingerprint' | 'publicKey'
  >;
  onCancel: () => void;
  onTrusted?: () => void;
}) {
  const { fleet } = useServices();
  const p = usePalette();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trust = () => {
    setBusy(true);
    setError(null);
    fleet
      .trust(device.deviceId, device.publicKey)
      .then(() => onTrusted?.())
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };

  return (
    <Confirm
      title={`Make sure ${device.name} shows the same fingerprint:`}
      confirmLabel={`Trust ${device.name}`}
      busy={busy}
      onConfirm={trust}
      onCancel={onCancel}
    >
      <Fingerprint value={device.fingerprint} />
      <Text style={{ color: p.muted, fontSize: 13 }}>
        A trusted device can start and steer spaces, within the highest mode it
        is allowed.
      </Text>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Confirm>
  );
}
