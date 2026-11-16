/**
 * Home's picks for the next space (docs/mobile.md "New space"): where it
 * runs, how, and with what. The draft keeps only what was picked (also
 * when read back from the last session); what is shown is resolved
 * against the devices listed now.
 *
 * ```text
 * draft {deviceId?, projectId?, mode, pick}  ─▶ resolveHome(startable devices)
 *   device   picked and still startable, else the first
 *   project  picked and still on it, else its first
 *   mode     capped by the device
 *   pick     only on the device it was made for, parts it still lists
 * ```
 */
import type { FleetAgentView, FleetDeviceView } from '../fleet/types';
import type { FleetMode } from '../gen/fleet';
import { NO_PICK, running, type Pick } from './agents';
import { MODE_LABEL, capMode } from './logic';

export interface HomeDraft {
  deviceId: string | null;
  projectId: string | null;
  mode: FleetMode;
  /** Agent, model, effort picked, for `deviceId`. */
  pick: Pick;
}

export const NO_DRAFT: HomeDraft = {
  deviceId: null,
  projectId: null,
  mode: 'edit',
  pick: NO_PICK,
};

/** A project a space was started in, for the quick chips. */
export interface RecentProject {
  deviceId: string;
  projectId: string;
}

/** Recent projects kept (newest first). */
export const RECENT_MAX = 5;
/** Quick chips shown under the empty state. */
export const RECENT_SHOWN = 3;

export interface ResolvedHome {
  device: FleetDeviceView | null;
  project: { id: string; name: string } | null;
  mode: FleetMode;
  pick: Pick;
}

/** Only the parts of `pick` that `agents` still list. */
export function cleanPick(agents: readonly FleetAgentView[], pick: Pick): Pick {
  if (!pick.agent && !pick.model && !pick.effort) return NO_PICK;
  if (pick.agent && !agents.some((a) => a.id === pick.agent)) return NO_PICK;
  const of = running(agents, { ...pick, model: null, effort: null });
  if (!of) return NO_PICK;
  const model =
    pick.model && of.agent.models.some((m) => m.id === pick.model)
      ? pick.model
      : null;
  const levels = running(agents, { ...pick, model, effort: null })?.levels;
  const effort =
    pick.effort && levels?.includes(pick.effort) ? pick.effort : null;
  return { agent: pick.agent, model, effort };
}

/** What Home shows and starts with, from `startable` devices now. */
export function resolveHome(
  startable: readonly FleetDeviceView[],
  draft: HomeDraft,
): ResolvedHome {
  const named = startable.find((d) => d.deviceId === draft.deviceId);
  const device = named ?? startable[0] ?? null;
  if (!device) {
    return { device: null, project: null, mode: draft.mode, pick: NO_PICK };
  }
  const project =
    (named && device.projects.find((p) => p.id === draft.projectId)) ??
    device.projects[0] ??
    null;
  // A pick was made for its device's list: never carried to another.
  const ownPick = named || draft.deviceId === null;
  return {
    device,
    project,
    mode: capMode(draft.mode, device.maxMode),
    pick: ownPick ? cleanPick(device.agents, draft.pick) : NO_PICK,
  };
}

/** The draft after choosing where it runs: another device drops the
 *  agent pick (it lists its own) and caps the mode. */
export function chooseWhere(
  draft: HomeDraft,
  device: FleetDeviceView,
  projectId: string,
): HomeDraft {
  const same = draft.deviceId === device.deviceId;
  return {
    deviceId: device.deviceId,
    projectId,
    mode: capMode(draft.mode, device.maxMode),
    pick: same ? draft.pick : NO_PICK,
  };
}

/** `recent` with this start first, duplicates dropped, at most RECENT_MAX. */
export function addRecent(
  recent: readonly RecentProject[],
  deviceId: string,
  projectId: string,
): RecentProject[] {
  return [
    { deviceId, projectId },
    ...recent.filter(
      (r) => !(r.deviceId === deviceId && r.projectId === projectId),
    ),
  ].slice(0, RECENT_MAX);
}

export interface RecentChip extends RecentProject {
  /** "theodore · mac-A" */
  label: string;
  accessibilityLabel: string;
}

/** Quick chips: recent projects still startable, not the one shown. */
export function recentChips(
  recent: readonly RecentProject[],
  startable: readonly FleetDeviceView[],
  shown: { deviceId: string; projectId: string } | null,
): RecentChip[] {
  const out: RecentChip[] = [];
  for (const r of recent) {
    if (
      shown &&
      r.deviceId === shown.deviceId &&
      r.projectId === shown.projectId
    )
      continue;
    const d = startable.find((x) => x.deviceId === r.deviceId);
    const p = d?.projects.find((x) => x.id === r.projectId);
    if (!d || !p) continue;
    out.push({
      ...r,
      label: `${shorten(p.name, 18)} · ${shorten(d.name, 14)}`,
      accessibilityLabel: `Use ${p.name} on ${d.name}`,
    });
    if (out.length === RECENT_SHOWN) break;
  }
  return out;
}

/** `s` cut to `max` characters with an ellipsis. */
export function shorten(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join('')}…`;
}

/** The where chip: "mac-A · theodore" (short), read as "Runs on mac-A, project theodore". */
export function whereLabel(
  device: { name: string },
  project: { name: string },
): { label: string; accessibilityLabel: string } {
  return {
    label: `${shorten(device.name, 14)} · ${shorten(project.name, 16)}`,
    accessibilityLabel: `Runs on ${device.name}, project ${project.name}`,
  };
}

export interface DeviceRow {
  device: FleetDeviceView;
  /** It can take a space now. */
  enabled: boolean;
  /** "2 projects · up to Edit", "Offline", … */
  detail: string;
}

/**
 * The where sheet's devices: computers you trust, those that can take a
 * space first, then online, then by name; the others say why not.
 */
export function deviceRows(
  devices: readonly FleetDeviceView[],
  startable: readonly FleetDeviceView[],
): DeviceRow[] {
  const ok = new Set(startable.map((d) => d.deviceId));
  return devices
    .filter(
      (d) =>
        !d.thisDevice &&
        d.trusted &&
        (d.kind === 'desktop' || d.kind === 'daemon'),
    )
    .map((d) => {
      const enabled = ok.has(d.deviceId);
      const n = d.projects.length;
      const detail = enabled
        ? `${n} project${n === 1 ? '' : 's'} · up to ${MODE_LABEL[d.maxMode]}`
        : !d.online
          ? 'Offline'
          : !d.acceptsRemote
            ? "Doesn't take spaces from other devices"
            : 'No projects';
      return { device: d, enabled, detail };
    })
    .sort(
      (a, b) =>
        Number(b.enabled) - Number(a.enabled) ||
        Number(b.device.online) - Number(a.device.online) ||
        a.device.name.localeCompare(b.device.name),
    );
}
