import type { DeviceRow } from '../../ui/homeDraft';

/**
 * Where the where sheet opens: a lone device that can take a space opens
 * on its projects (its id); several, on the device list (`null`).
 */
export function firstStep(rows: readonly DeviceRow[]): string | null {
  const ok = rows.filter((r) => r.enabled);
  return ok.length === 1 ? ok[0]!.device.deviceId : null;
}
