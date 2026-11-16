/**
 * What the Devices screen says about a device, as plain strings (no React
 * Native), so the wording is tested and the same on iOS, Android and web.
 */
import type { FleetDeviceView } from '../fleet/types';
import { MODE_LABEL, kindLabel, osLabel, sortDevices } from './logic';
import type { ConfirmOptions } from './native/types';

/** This device's link to the cloud, as Settings and Devices say it. */
export const CONNECTION_LABEL = {
  off: 'Off',
  connecting: 'Connecting…',
  connected: 'Connected',
  error: 'Not connected',
} as const;

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

/** The agents a computer offers, "Claude · Codex"; empty when none. */
export const agentsLine = (agents: readonly { label: string }[]): string =>
  agents.map((a) => a.label).join(' · ');

/** Computers (they run spaces) first, then phones and browsers. */
export const isComputer = (kind: string): boolean =>
  kind === 'desktop' || kind === 'daemon';

export interface DeviceGroup {
  key: 'computers' | 'clients';
  title: string;
  devices: FleetDeviceView[];
}

/**
 * The Devices list: computers, then phones and browsers, each by
 * `sortDevices` (online first, then by name); empty groups left out.
 */
export function groupDevices(
  devices: readonly FleetDeviceView[],
): DeviceGroup[] {
  const sorted = sortDevices(devices);
  const groups: DeviceGroup[] = [
    {
      key: 'computers',
      title: 'Computers',
      devices: sorted.filter((d) => isComputer(d.kind)),
    },
    {
      key: 'clients',
      title: 'Phones and browsers',
      devices: sorted.filter((d) => !isComputer(d.kind)),
    },
  ];
  return groups.filter((g) => g.devices.length > 0);
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
  /** `agentsLine()`: what a computer offers; empty, no line. */
  agents: string;
}

/**
 * A fingerprint in monospace, selectable: this device's, large, to read
 * out to the computer (Devices), or under a caption (Settings).
 */
export interface FingerprintItemProps {
  value: string;
  /** A caption above it ("Fingerprint"). */
  label?: string;
  /** Default `regular`. */
  size?: 'regular' | 'large';
}
