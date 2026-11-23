/**
 * Archiving a space from the drawer row's long-press menu: `archiveSpaceFlow`
 * (`./archiveFlow.ts`) bound to the app's fleet client, store, alert, toast
 * and telemetry.
 *
 * The request goes over the fleet link of the active account (the client is
 * redialed as it on a switch): a space of another account isn't listed here.
 */
import { useCallback } from 'react';
import type { SpaceView } from '../fleet/types';
import { useServices } from '../services';
import { useFleetState } from '../state/fleet';
import { showToast } from '../state/toast';
import { track } from '../telemetry/log';
import { archiveSpaceFlow, type ArchiveSurface } from './archiveFlow';
import { confirm } from './native';

export type { ArchiveSurface } from './archiveFlow';

/** Confirms, stops when needed and archives `space`; `true` once archived. */
export function useArchive(
  surface: ArchiveSurface,
): (space: SpaceView) => Promise<boolean> {
  const { fleet } = useServices();
  return useCallback(
    (space: SpaceView) =>
      archiveSpaceFlow(
        {
          fleet,
          row: (id) => useFleetState.getState().mirrors[id]?.space ?? null,
          confirm,
          showToast,
          track,
        },
        surface,
        space,
      ),
    [fleet, surface],
  );
}
