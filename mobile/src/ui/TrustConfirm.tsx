/**
 * Trusting a device (docs/fleet.md "Trust"): the system confirm shows its
 * fingerprint in full, to compare with what that device shows for itself,
 * and "Trust <name>" pins it. The key sent is the one this fingerprint is of.
 *
 * ```text
 * Trust ─▶ confirm (UIAlertController / Material AlertDialog / window.confirm)
 *            ├─ Cancel          ─▶ nothing
 *            └─ Trust <name>    ─▶ fleet.trust ─▶ Trusted   (error ─▶ `error`)
 * Untrust ─▶ fleet.untrust (no confirm: trusting again is one step)
 * ```
 */
import { useState } from 'react';
import { useServices } from '../services';
import type { FleetDeviceView } from '../fleet/types';
import { trustPrompt } from './deviceView';
import { errorText } from './logic';
import { confirm } from './native';

export function useTrust(
  device: Pick<
    FleetDeviceView,
    'deviceId' | 'name' | 'fingerprint' | 'publicKey'
  >,
) {
  const { fleet } = useServices();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    action()
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };

  const trust = async () => {
    if (busy) return;
    if (!(await confirm(trustPrompt(device)))) return;
    run(() => fleet.trust(device.deviceId, device.publicKey));
  };

  const untrust = () => {
    if (busy) return;
    run(() => fleet.untrust(device.deviceId));
  };

  return { trust, untrust, busy, error };
}
