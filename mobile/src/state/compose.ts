/**
 * What the composers have picked (zustand), shared with the picker sheets:
 * a sheet is its own route on iOS, so the picks can't live in the screen.
 *
 * ```text
 * Home                 home: {deviceId, projectId, mode, pick}  remembered per <user>.<org>
 *                      recent: projects spaces were started in
 * space/[id]           spacePicks[id]: agent, model, effort from its next message on
 * sheet (target)       null ─▶ Home's draft, a space id ─▶ that space's pick
 *
 * scope (account + org) changes ─▶ cleared ─▶ the scope's last picks read back
 * home / recent change          ─▶ written 300 ms later (lastPicks.ts)
 * sign-out                      ─▶ the scope's record removed
 * ```
 */
import { create } from 'zustand';
import { createDataStorage } from '../fleet/data';
import type { FleetSnapshot } from '../fleet/types';
import type { FleetMode } from '../gen/fleet';
import { NO_PICK, spaceOwn, type Pick as AgentPick } from '../ui/agents';
import {
  NO_DRAFT,
  addRecent,
  chooseWhere,
  resolveHome,
  type HomeDraft,
  type RecentProject,
} from '../ui/homeDraft';
import { startableDevices } from '../ui/logic';
import { chooseModel, closesAfter } from '../ui/modelPicker';
import { useFleetState } from './fleet';
import { lastPicksStore, type LastPicksStore } from './lastPicks';

export interface ComposeState {
  /** `<user>.<org>` the picks belong to; `null`: none (signed out). */
  scope: string | null;
  /** The scope's last picks were read back (or there were none). */
  restored: boolean;
  home: HomeDraft;
  recent: RecentProject[];
  spacePicks: Record<string, AgentPick>;
  /** Bumped by "new space": Home clears its goal and focuses the field. */
  fresh: number;
}

const initial: ComposeState = {
  scope: null,
  restored: false,
  home: NO_DRAFT,
  recent: [],
  spacePicks: {},
  fresh: 0,
};

export const useCompose = create<ComposeState>(() => initial);

/** Back to nothing picked (tests). */
export function resetCompose(): void {
  useCompose.setState(initial, true);
}

// ── the sheets' target ─────────────────────────────────────────────────────

/** What a picker sheet works on: Home (`space` null) or a space. */
export interface PickerContext {
  agents: FleetSnapshot['devices'][number]['agents'];
  pick: AgentPick;
  /** The space's own (its mirrored row); Home: nothing. */
  current: AgentPick;
}

export function pickerContext(
  fleet: Pick<FleetSnapshot, 'devices' | 'spaces' | 'mirrors'>,
  c: Pick<ComposeState, 'home' | 'spacePicks'>,
  space: string | null,
): PickerContext {
  if (space === null) {
    const r = resolveHome(startableDevices(fleet.devices), c.home);
    return { agents: r.device?.agents ?? [], pick: r.pick, current: NO_PICK };
  }
  const s = fleet.spaces.find((x) => x.space === space);
  const host = fleet.devices.find((d) => d.deviceId === s?.hostDevice);
  return {
    agents: host?.agents ?? [],
    pick: c.spacePicks[space] ?? NO_PICK,
    current: spaceOwn(fleet.mirrors[space]?.space),
  };
}

const context = (space: string | null) =>
  pickerContext(useFleetState.getState(), useCompose.getState(), space);

/** The pick of `space` (null: Home's draft, pinned to the device shown). */
export function setPick(space: string | null, pick: AgentPick): void {
  if (space !== null) {
    useCompose.setState((c) => ({
      spacePicks: { ...c.spacePicks, [space]: pick },
    }));
    return;
  }
  useCompose.setState((c) => {
    const r = resolveHome(
      startableDevices(useFleetState.getState().devices),
      c.home,
    );
    return {
      home: {
        ...c.home,
        // A pick belongs to the device it was made on.
        deviceId: r.device?.deviceId ?? c.home.deviceId,
        projectId: r.project?.id ?? c.home.projectId,
        pick,
      },
    };
  });
}

/** A model row tapped; `true`: the sheet closes (no effort to choose). */
export function applyModel(
  space: string | null,
  agent: string,
  model: string | null,
): boolean {
  const { agents, pick, current } = context(space);
  const next = chooseModel(agents, pick, current, agent, model);
  setPick(space, next);
  return closesAfter(agents, next, current);
}

/** An effort picked; `null`: back to the default. */
export function applyEffort(space: string | null, effort: string | null): void {
  setPick(space, { ...context(space).pick, effort });
}

/** Reset to defaults: nothing picked. */
export function resetPick(space: string | null): void {
  setPick(space, NO_PICK);
}

/** Home: where the next space runs. */
export function applyWhere(deviceId: string, projectId: string): void {
  const device = useFleetState
    .getState()
    .devices.find((d) => d.deviceId === deviceId);
  if (!device) return;
  useCompose.setState((c) => ({
    home: chooseWhere(c.home, device, projectId),
  }));
}

export function setHomeMode(mode: FleetMode): void {
  useCompose.setState((c) => ({ home: { ...c.home, mode } }));
}

/** A space was started there: first of the recent projects. */
export function noteStarted(deviceId: string, projectId: string): void {
  useCompose.setState((c) => ({
    recent: addRecent(c.recent, deviceId, projectId),
  }));
}

/** "New space": Home's goal cleared, its composer focused. */
export function requestNewSpace(): void {
  useCompose.setState((c) => ({ fresh: c.fresh + 1 }));
}

// ── kept across restarts ───────────────────────────────────────────────────

let defaultStore: LastPicksStore | null = null;
/** The app's store of last picks (the platform's data storage). */
export function picksStore(): LastPicksStore {
  defaultStore ??= lastPicksStore(createDataStorage());
  return defaultStore;
}

/**
 * Switches to `scope`'s picks: clears what was picked, then reads its last
 * ones back. A pick made while reading wins over what was stored.
 */
export async function restorePicks(
  store: LastPicksStore,
  scope: string | null,
): Promise<void> {
  if (useCompose.getState().scope === scope) return;
  useCompose.setState({
    scope,
    restored: scope === null,
    home: NO_DRAFT,
    recent: [],
    spacePicks: {},
  });
  if (scope === null) return;
  const last = await store.load(scope);
  const now = useCompose.getState();
  if (now.scope !== scope) return;
  const untouched = now.home === NO_DRAFT && now.recent.length === 0;
  useCompose.setState(
    last && untouched
      ? { home: last.draft, recent: last.recent, restored: true }
      : { restored: true },
  );
}

/** Writes Home's picks `delayMs` after they change; returns the unsubscribe. */
export function persistPicks(store: LastPicksStore, delayMs = 300): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const off = useCompose.subscribe((c, prev) => {
    if (!c.restored || !c.scope) return;
    if (c.scope !== prev.scope) return;
    if (c.home === prev.home && c.recent === prev.recent) return;
    if (timer) clearTimeout(timer);
    const scope = c.scope;
    timer = setTimeout(() => {
      timer = null;
      const s = useCompose.getState();
      if (s.scope !== scope) return;
      void store
        .save(scope, { draft: s.home, recent: s.recent })
        .catch((e: unknown) => console.warn('[picks] not saved', e));
    }, delayMs);
  });
  return () => {
    if (timer) clearTimeout(timer);
    off();
  };
}
