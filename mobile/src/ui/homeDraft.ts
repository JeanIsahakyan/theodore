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

/** A project a space was started in (the project sheet's Recent). */
export interface RecentProject {
  deviceId: string;
  projectId: string;
}

/** Recent projects kept (newest first). */
export const RECENT_MAX = 5;

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

/** The project a space was last started in on `device`, still on it. */
export function lastProjectOn(
  recent: readonly RecentProject[],
  device: FleetDeviceView,
): string | null {
  for (const r of recent) {
    if (r.deviceId !== device.deviceId) continue;
    if (device.projects.some((p) => p.id === r.projectId)) return r.projectId;
  }
  return null;
}

/** The project sheet offers a search field from this many projects on. */
export const PROJECT_SEARCH_MIN = 7;

export interface ProjectGroups {
  /** Recently started in, newest first. */
  recent: { id: string; name: string }[];
  /** The others, as the device lists them. */
  rest: { id: string; name: string }[];
}

/** The project sheet's lists for `device`, cut to those naming `query`. */
export function projectGroups(
  device: FleetDeviceView,
  recent: readonly RecentProject[],
  query = '',
): ProjectGroups {
  const q = query.trim().toLowerCase();
  const hit = (p: { name: string }) => !q || p.name.toLowerCase().includes(q);
  const ids = recent
    .filter((r) => r.deviceId === device.deviceId)
    .map((r) => r.projectId);
  const mine = ids
    .map((id) => device.projects.find((p) => p.id === id))
    .filter((p): p is { id: string; name: string } => !!p);
  return {
    recent: mine.filter(hit),
    rest: device.projects.filter((p) => !ids.includes(p.id) && hit(p)),
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
 * The computer sheet's devices: computers you trust, those that can take a
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
