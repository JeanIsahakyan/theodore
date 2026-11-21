/** What the fleet's decision dialog and the tab bar's chips show, with no
 *  React (docs/fleet.md "Auto mode and remote prompts"): the prompts
 *  waiting for a decision, in the order the dialog queues them, and the
 *  auto modes on now, here and on the other computers this one knows of. */
import type {
  FleetAuto,
  FleetConfirm,
  FleetDevice,
  FleetAutoOn,
  FleetTrustNeeded,
} from '../../gen/contract';
import { AUTO_ORDER, autoOn, isClient } from './fleet';

export const CLOUD_CLAUDE = 'Claude via cloud';

/** Said on a prompt waiting on another computer, where the full warning's
 *  "on this computer" would be wrong. */
export const CLOUD_KEY_NOTE =
  'Its key is held by the Theodore cloud, not by a device of yours.';

/** One decision waiting: a request from Claude via cloud (here or on a
 *  computer that sends its prompts here), or a device asking to be
 *  trusted. `key` is unique across both. */
export type PendingPrompt =
  | { kind: 'confirm'; key: string; request: FleetConfirm }
  | { kind: 'trust'; key: string; request: FleetTrustNeeded };

/** The dialog's queue at `now`: requests still in time, the one running
 *  out first on top (as `confirms` comes), then the trust requests. */
export function pendingPrompts(
  confirms: readonly FleetConfirm[],
  trusts: readonly FleetTrustNeeded[],
  now: number,
): PendingPrompt[] {
  return [
    ...confirms
      .filter((c) => c.expires_at_ms > now)
      .map((c) => ({
        kind: 'confirm' as const,
        key: `confirm:${c.id}`,
        request: c,
      })),
    ...trusts.map((t) => ({
      kind: 'trust' as const,
      key: `trust:${t.device_id}`,
      request: t,
    })),
  ];
}

/** "4:05", "0:09": time left before the automatic refusal. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** What the text under a request is, by its action. */
export function confirmTextLabel(c: FleetConfirm): string {
  switch (c.action) {
    case 'start':
      return 'Goal';
    case 'merge':
      return 'Sub-space';
    default:
      return 'Message';
  }
}

/** One auto mode on now: Claude via cloud device `deviceId` on this
 *  computer (`hostDevice` null) or on another one. */
export interface AutoEntry {
  key: string;
  deviceId: string;
  /** The Claude via cloud device's name. */
  name: string;
  hostDevice: string | null;
  hostName: string;
  auto: FleetAuto;
  until: number | null;
  /** `false`: that computer is offline or not trusted here. */
  canTurnOff: boolean;
  /** Why it can't be turned off from here. */
  why?: string;
}

/** Every auto mode on at `now`: this computer's first, then those other
 *  computers list for themselves. */
export function autoEntries(
  autos: readonly FleetAutoOn[],
  devices: readonly FleetDevice[],
  now: number,
): AutoEntry[] {
  const here: AutoEntry[] = autos
    .filter((a) => autoOn(a.auto, a.until_ms, now))
    .map((a) => ({
      key: `here:${a.device_id}`,
      deviceId: a.device_id,
      name: a.device_name,
      hostDevice: null,
      hostName: 'This computer',
      auto: a.auto,
      until: a.until_ms,
      canTurnOff: true,
    }));
  const elsewhere: AutoEntry[] = devices
    .filter((d) => !d.this_device && !isClient(d))
    .flatMap((d) =>
      (d.mcp_auto ?? [])
        .filter((a) => autoOn(a.auto, a.until_ms, now))
        .map((a) => ({
          key: `${d.device_id}:${a.device_id}`,
          deviceId: a.device_id,
          name: a.name,
          hostDevice: d.device_id,
          hostName: d.name,
          auto: a.auto,
          until: a.until_ms,
          canTurnOff: d.trusted && d.online,
          why: !d.trusted
            ? `Trust ${d.name} to change it.`
            : !d.online
              ? `${d.name} is offline.`
              : undefined,
        })),
    );
  return [...here, ...elsewhere];
}

/** The entry the chip names: the most powerful, and of those the one
 *  lasting longest (until turned off first). */
export function topAuto(entries: readonly AutoEntry[]): AutoEntry | undefined {
  const rank = (e: AutoEntry) => AUTO_ORDER.indexOf(e.auto);
  const end = (e: AutoEntry) => e.until ?? Infinity;
  return [...entries].sort((a, b) => rank(b) - rank(a) || end(b) - end(a))[0];
}

/** "18:00" today, "Nov 21, 09:00" later; `null` until turned off. */
export function untilShort(
  until: number | null | undefined,
  now: number,
): string | null {
  if (until == null) return null;
  const at = new Date(until);
  const time = at.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  if (at.toDateString() === new Date(now).toDateString()) return time;
  const day = at.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${day}, ${time}`;
}
