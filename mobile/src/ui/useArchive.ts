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
 *   each ─▶ track space_archived {action, surface, stopped_first, outcome, code}
 * ```
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
import {
  archiveConfirm,
  archiveErrorText,
  hasUnshippedChanges,
} from './archive';
import { refusalCode } from './logic';
import { confirm } from './native';

/** Where Archive was pressed, for telemetry. */
export type ArchiveSurface = 'drawer' | 'header';

/** Confirms, stops when needed and archives `space`; `true` once archived. */
export function useArchive(
  surface: ArchiveSurface,
): (space: SpaceView) => Promise<boolean> {
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
        track('space_archived', {
          action: 'archive',
          surface,
          stopped_first: ask.stopFirst,
          outcome: 'failed',
          code: refusalCode(e),
        });
        showToast({ text: archiveErrorText(e, space.hostName) });
        return false;
      }
      track('space_archived', {
        action: 'archive',
        surface,
        stopped_first: ask.stopFirst,
        outcome: 'ok',
        code: null,
      });
      showToast({
        text: 'Archived',
        action: {
          label: 'Undo',
          onPress: () => {
            fleet
              .unarchiveSpace(id)
              .then(() =>
                track('space_archived', {
                  action: 'unarchive',
                  surface,
                  stopped_first: false,
                  outcome: 'ok',
                  code: null,
                }),
              )
              .catch((e: unknown) => {
                track('space_archived', {
                  action: 'unarchive',
                  surface,
                  stopped_first: false,
                  outcome: 'failed',
                  code: refusalCode(e),
                });
                showToast({ text: archiveErrorText(e, space.hostName) });
              });
          },
        },
      });
      return true;
    },
    [fleet, surface],
  );
}
