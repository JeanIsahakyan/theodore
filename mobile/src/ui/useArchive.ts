/**
 * Archiving a space from the drawer or a space's header (rules:
 * `./archive.ts`; docs/mobile.md "Archive"):
 *
 * ```text
 * Archive ─▶ confirm(archiveConfirm)   Cancel ─▶ nothing
 *   ├─ running ─▶ fleet.stopSpace ─▶ fleet.archiveSpace
 *   └─ else                       ─▶ fleet.archiveSpace
 *   ok    ─▶ toast "Archived · Undo"   Undo ─▶ fleet.unarchiveSpace
 *   error ─▶ toast archiveErrorText (busy, upgrade_required, …)
 * ```
 */
import { useCallback } from 'react';
import type { SpaceView } from '../fleet/types';
import { useServices } from '../services';
import { useFleetState } from '../state/fleet';
import { showToast } from '../state/toast';
import {
  archiveConfirm,
  archiveErrorText,
  hasUnshippedChanges,
} from './archive';
import { confirm } from './native';

/** Confirms, stops when needed and archives `space`; `true` once archived. */
export function useArchive(): (space: SpaceView) => Promise<boolean> {
  const { fleet } = useServices();
  return useCallback(
    async (space: SpaceView) => {
      const id = space.space;
      const row = useFleetState.getState().mirrors[id]?.space ?? null;
      const ask = archiveConfirm(space, {
        unshipped: hasUnshippedChanges(row),
      });
      const sure = await confirm({
        title: ask.title,
        message: ask.message,
        confirmLabel: ask.confirmLabel,
        destructive: true,
      });
      if (!sure) return false;
      try {
        if (ask.stopFirst) await fleet.stopSpace(id);
        await fleet.archiveSpace(id);
      } catch (e: unknown) {
        showToast({ text: archiveErrorText(e, space.hostName) });
        return false;
      }
      showToast({
        text: 'Archived',
        action: {
          label: 'Undo',
          onPress: () => {
            fleet.unarchiveSpace(id).catch((e: unknown) => {
              showToast({ text: archiveErrorText(e, space.hostName) });
            });
          },
        },
      });
      return true;
    },
    [fleet],
  );
}
