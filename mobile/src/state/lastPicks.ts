/**
 * Home's last picks, kept across restarts per account and organization
 * (next to the saved spaces, `src/fleet/saved.ts`, in the same data
 * storage): the device, project, mode, agent, model and effort picked,
 * and the projects spaces were last started in.
 *
 * ```text
 * <data storage>
 *   theodore.fleet.picks.<user>.<org>   {v, deviceId, projectId, mode, agent, model, effort, recent}
 *
 * a pick changes ─▶ written (debounced)      sign-out ─▶ removed
 * start          ─▶ read back ─▶ shape-checked ─▶ the draft; still valid?
 *                   is decided on screen against the devices listed then
 *                   (src/ui/homeDraft.ts resolveHome)
 * ```
 */
import type { DataStorage } from '../fleet/data';
import { isMode } from '../fleet/rules';
import { NO_PICK } from '../ui/agents';
import {
  NO_DRAFT,
  RECENT_MAX,
  type HomeDraft,
  type RecentProject,
} from '../ui/homeDraft';

const VERSION = 1;
/** Longest id kept (device, project, agent, model, effort). */
const ID_MAX = 200;

export interface LastPicks {
  draft: HomeDraft;
  recent: RecentProject[];
}

export const NO_LAST_PICKS: LastPicks = { draft: NO_DRAFT, recent: [] };

export const lastPicksKey = (scope: string): string =>
  `theodore.fleet.picks.${scope}`;

const id = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' && v.length <= ID_MAX ? v : null;

/** What was stored, shape-checked; anything off is dropped, not trusted. */
export function parseLastPicks(text: string | null): LastPicks | null {
  if (!text) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.v !== VERSION) return null;
  const deviceId = id(o.deviceId);
  const recent = Array.isArray(o.recent)
    ? o.recent
        .map((r): RecentProject | null => {
          if (!r || typeof r !== 'object') return null;
          const x = r as Record<string, unknown>;
          const d = id(x.deviceId);
          const p = id(x.projectId);
          return d && p ? { deviceId: d, projectId: p } : null;
        })
        .filter((r): r is RecentProject => r !== null)
        .slice(0, RECENT_MAX)
    : [];
  return {
    draft: {
      deviceId,
      // A project only names one on its device.
      projectId: deviceId ? id(o.projectId) : null,
      mode: isMode(o.mode) ? o.mode : NO_DRAFT.mode,
      pick: deviceId
        ? { agent: id(o.agent), model: id(o.model), effort: id(o.effort) }
        : NO_PICK,
    },
    recent,
  };
}

export function serializeLastPicks(l: LastPicks): string {
  const { draft, recent } = l;
  return JSON.stringify({
    v: VERSION,
    deviceId: draft.deviceId,
    projectId: draft.projectId,
    mode: draft.mode,
    agent: draft.pick.agent,
    model: draft.pick.model,
    effort: draft.pick.effort,
    recent: recent.slice(0, RECENT_MAX),
  });
}

export function lastPicksStore(data: DataStorage) {
  return {
    async load(scope: string): Promise<LastPicks | null> {
      try {
        return parseLastPicks(await data.get(lastPicksKey(scope)));
      } catch {
        return null;
      }
    },
    save(scope: string, l: LastPicks): Promise<void> {
      return data.set(lastPicksKey(scope), serializeLastPicks(l));
    },
    clear(scope: string): Promise<void> {
      return data.remove(lastPicksKey(scope));
    },
  };
}

export type LastPicksStore = ReturnType<typeof lastPicksStore>;
