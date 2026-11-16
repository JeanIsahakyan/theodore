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

/**
 * A device card's line: "macOS · up to Edit · Claude, Codex" (the OS, the
 * highest mode it runs spaces in when it takes them, the agents it
 * offers). The kind is the card's icon, online its pill.
 */
export function deviceLine(
  d: Pick<FleetDeviceView, 'os' | 'acceptsRemote' | 'maxMode'> & {
    agents: readonly { label: string }[];
  },
): string {
  const parts = [osLabel(d.os)];
  if (d.acceptsRemote) parts.push(`up to ${MODE_LABEL[d.maxMode]}`);
  if (d.agents.length > 0) parts.push(d.agents.map((a) => a.label).join(', '));
  return parts.join(' · ');
}

/** A device card's header as a screen reader says it. */
export function deviceSummary(
  d: Pick<FleetDeviceView, 'name' | 'kind' | 'online' | 'trusted'>,
): string {
  return [
    d.name,
    kindLabel(d.kind),
    d.online ? 'online' : 'offline',
    d.trusted ? 'trusted' : 'not trusted',
  ].join(', ');
}

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

/** "2 of 3 online" under a group's title; "" for an empty group. */
export function groupOnline(devices: readonly { online: boolean }[]): string {
  if (devices.length === 0) return '';
  const on = devices.filter((d) => d.online).length;
  if (on === devices.length)
    return devices.length === 1 ? 'online' : 'all online';
  if (on === 0) return devices.length === 1 ? 'offline' : 'all offline';
  return `${on} of ${devices.length} online`;
}

/** The fingerprint as a screen reader reads it: group by group. */
export const fingerprintLabel = (value: string): string =>
  `Fingerprint ${value.split(' ').join(', ')}`;

/**
 * A fingerprint shown large: its groups as two lines (4 + 4), so it reads
 * like the computer shows it and never wraps inside a group.
 */
export function fingerprintLines(value: string): string[] {
  const groups = value.split(' ').filter(Boolean);
  if (groups.length <= 4) return groups.length ? [groups.join(' ')] : [];
  const half = Math.ceil(groups.length / 2);
  return [groups.slice(0, half).join(' '), groups.slice(half).join(' ')];
}

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
