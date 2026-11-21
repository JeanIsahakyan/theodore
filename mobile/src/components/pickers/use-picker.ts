/**
 * What the picker sheets read, as hooks: the target's agents and picks
 * (`pickerContext`), Home's resolved draft, the sheet's view models.
 */
import { useMemo } from 'react';
import type { FleetMode } from '../../gen/fleet';
import {
  pickerContext,
  spaceModeNow,
  useCompose,
  type PickerContext,
} from '../../state/compose';
import { useFleetState } from '../../state/fleet';
import { composerModes } from '../../ui/chat';
import {
  deviceRows,
  projectGroups,
  resolveHome,
  type ProjectGroups,
  type ResolvedHome,
} from '../../ui/homeDraft';
import { offeredMode, startableDevices } from '../../ui/logic';
import {
  effortView,
  hasPick,
  modelSections,
  topModels,
} from '../../ui/modelPicker';

export function usePickerContext(space: string | null): PickerContext {
  const devices = useFleetState((s) => s.devices);
  const spaces = useFleetState((s) => s.spaces);
  const mirrors = useFleetState((s) => s.mirrors);
  const home = useCompose((s) => s.home);
  const spacePicks = useCompose((s) => s.spacePicks);
  return useMemo(
    () =>
      pickerContext({ devices, spaces, mirrors }, { home, spacePicks }, space),
    [devices, spaces, mirrors, home, spacePicks, space],
  );
}

/** The model sheet: its top, every model by agent, the effort, whether
 *  Reset has anything to do. */
export function useModelSheet(space: string | null) {
  // Destructured: the React Compiler reads `x.current` as a ref.
  const { agents, pick, current: own } = usePickerContext(space);
  return useMemo(
    () => ({
      agents,
      top: topModels(agents, pick, own),
      sections: modelSections(agents, pick, own),
      effort: effortView(agents, pick, own),
      canReset: hasPick(pick),
      empty: agents.length === 0,
    }),
    [agents, pick, own],
  );
}

/** A space's mode for its next message, among those its host allows. */
export interface SpaceModeView {
  /** Up to the host's cap; all when the host doesn't list one. */
  modes: FleetMode[];
  /** What the next message goes in (the model sheet's Mode step). */
  picked: FleetMode;
  /** The space's own: its last turn's. */
  own: FleetMode;
}

/** The mode of `space`'s next message; `null` for Home or a space gone. */
export function useSpaceMode(space: string | null): SpaceModeView | null {
  const s = useFleetState((st) => st.spaces.find((x) => x.space === space));
  const host = useFleetState((st) =>
    st.devices.find((d) => d.deviceId === s?.hostDevice),
  );
  const pick = useCompose((c) => (space ? c.spaceModes[space] : undefined));
  const own = s?.mode;
  const max = host?.maxMode ?? null;
  return useMemo(() => {
    if (!own) return null;
    const modes = composerModes(max);
    return { modes, picked: offeredMode(modes, spaceModeNow(pick, own)), own };
  }, [own, max, pick]);
}

/** Home's startable devices and what it shows now. */
export function useHome(): ResolvedHome & {
  startable: ReturnType<typeof startableDevices>;
} {
  const devices = useFleetState((s) => s.devices);
  const home = useCompose((s) => s.home);
  const startable = useMemo(() => startableDevices(devices), [devices]);
  return useMemo(
    () => ({ ...resolveHome(startable, home), startable }),
    [startable, home],
  );
}

/** The project sheet's lists for the computer shown. */
export function useProjectGroups(query: string): ProjectGroups {
  const { device } = useHome();
  const recent = useCompose((s) => s.recent);
  return useMemo(
    () =>
      device ? projectGroups(device, recent, query) : { recent: [], rest: [] },
    [device, recent, query],
  );
}

/** The computer sheet's rows. */
export function useDeviceRows() {
  const devices = useFleetState((s) => s.devices);
  return useMemo(
    () => deviceRows(devices, startableDevices(devices)),
    [devices],
  );
}
