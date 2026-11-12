/** Trusting a device (docs/fleet.md): its fingerprint in full, to compare
 *  with what that device shows for itself, and only then the button that
 *  pins it. The key sent is the one this fingerprint is of, so what was
 *  compared is exactly what gets pinned. Settings → Devices and the "wants
 *  to run spaces here" notice both trust through it. */
import { useState } from 'react';
import { Button } from '@heroui/react';
import { useRootStore } from '../../stores/context';

/** "a1b2 c3d4 …" — all 8 groups, wrapping rather than clipped — in a box
 *  to read aloud and compare. */
export function Fingerprint({ value }: { value: string }) {
  return (
    <code className="fingerprint inline-block max-w-full whitespace-normal rounded-md bg-default px-2 py-0.5 font-mono text-xs [overflow-wrap:anywhere]">
      {value || '—'}
    </code>
  );
}

export function TrustConfirm({
  deviceId,
  name,
  fingerprint,
  publicKey,
  onCancel,
  onTrusted,
}: {
  deviceId: string;
  name: string;
  fingerprint: string;
  /** The key `fingerprint` is of. */
  publicKey: string;
  onCancel: () => void;
  onTrusted?: () => void;
}) {
  const fleet = useRootStore().fleet;
  const [busy, setBusy] = useState(false);
  const trust = () => {
    setBusy(true);
    void fleet
      .trust(deviceId, publicKey)
      .then(() => onTrusted?.())
      .catch(() => {
        // toasted by api.ts (e.g. the key changed meanwhile); it stays open
      })
      .finally(() => setBusy(false));
  };
  return (
    <div
      role="alertdialog"
      aria-label={`Trust ${name}`}
      className="fleet-confirm flex flex-col gap-2 rounded-lg border border-warning/40 p-3"
    >
      <span className="text-sm">
        Make sure <span className="font-medium">{name}</span> shows the same
        fingerprint:
      </span>
      <Fingerprint value={fingerprint} />
      <span className="text-xs text-muted">
        A trusted device can start and steer spaces here, within the highest
        mode set in Settings → Devices.
      </span>
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          className="fleet-confirm-cancel"
          onPress={onCancel}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          className="fleet-confirm-trust"
          isPending={busy}
          onPress={trust}
        >
          Trust {name}
        </Button>
      </div>
    </div>
  );
}
