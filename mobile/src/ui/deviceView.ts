/**
 * What the Devices screen says about a device, as plain strings (no React
 * Native), so the wording is tested and the same on iOS, Android and web.
 */
import type { FleetDeviceView } from '../fleet/types';
import { MODE_LABEL, kindLabel, osLabel } from './logic';
import type { ConfirmOptions } from './native/types';

/** "Computer · macOS · online · runs spaces up to Edit". */
export function deviceDetail(
  d: Pick<
    FleetDeviceView,
    'kind' | 'os' | 'online' | 'acceptsRemote' | 'maxMode'
  >,
): string {
  const parts = [
    kindLabel(d.kind),
    osLabel(d.os),
    d.online ? 'online' : 'offline',
  ];
  if (d.acceptsRemote) parts.push(`runs spaces up to ${MODE_LABEL[d.maxMode]}`);
  return parts.join(' · ');
}

/** The fingerprint as a screen reader reads it: group by group. */
export const fingerprintLabel = (value: string): string =>
  `Fingerprint ${value.split(' ').join(', ')}`;

/**
 * The trust confirm (docs/fleet.md "Trust"): the device's fingerprint in
 * full, to compare with what that device shows for itself; the confirm
 * action names the device.
 */
export function trustPrompt(
  d: Pick<FleetDeviceView, 'name' | 'fingerprint'>,
): ConfirmOptions {
  return {
    title: `Make sure ${d.name} shows the same fingerprint:`,
    message: `${d.fingerprint}\n\nA trusted device can start and steer spaces, within the highest mode it is allowed.`,
    confirmLabel: `Trust ${d.name}`,
  };
}

/** A device in the Devices list (`./DeviceItem`, one per platform). */
export interface DeviceItemProps {
  name: string;
  /** desktop | daemon | mobile | web */
  kind: string;
  online: boolean;
  /** `deviceDetail()` */
  detail: string;
  fingerprint: string;
  trusted: boolean;
}

/** This device's fingerprint, large, to read out to the computer. */
export interface FingerprintItemProps {
  value: string;
}
