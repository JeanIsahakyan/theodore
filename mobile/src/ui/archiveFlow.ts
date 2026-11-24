/**
 * Archiving a space from the phone, the flow itself (rules: `./archive.ts`;
 * docs/mobile.md "Archive"). Its dependencies come in, so the tests run it
 * without the app; `useArchive` binds the real ones.
 *
 * ```text
 * Archive ─▶ confirm(archiveConfirm)   Cancel ─▶ nothing
 *   ├─ running ─▶ fleet.stopSpace ─▶ fleet.archiveSpace
 *   └─ else                       ─▶ fleet.archiveSpace
 *   ok    ─▶ toast "Archived · Undo"   Undo ─▶ fleet.unarchiveSpace
 *   error ─▶ toast archiveErrorText (busy, upgrade_required, …)
 *   each ─▶ track space_archived {action, surface, stopped_first, outcome, code}
 * ```
 */
import type { Space } from '../fleet/contract';
import type { SpaceView } from '../fleet/types';
import type { Toast } from '../state/toast';
import type { ConfirmOptions } from './native/types';
import {
  archiveConfirm,
  archiveErrorText,
  hasUnshippedChanges,
} from './archive';
import { refusalCode } from './logic';

/**
 * Where Archive was chosen, for telemetry: the drawer row's long-press menu,
 * or the space screen's "Merged #N" chip (src/ui/merged.ts).
 */
export type ArchiveSurface = 'row_menu' | 'merged_chip';

export interface ArchiveTelemetry {
  action: 'archive' | 'unarchive';
  surface: ArchiveSurface;
  stopped_first: boolean;
  outcome: 'ok' | 'failed';
  code: string | null;
}

export interface ArchiveDeps {
  fleet: {
    stopSpace: (space: string) => Promise<unknown>;
    archiveSpace: (space: string) => Promise<unknown>;
    unarchiveSpace: (space: string) => Promise<unknown>;
  };
  /** The space's mirrored row, for the unshipped-changes warning. */
  row: (
    space: string,
  ) => Pick<Space, 'pr' | 'shipped' | 'head_sha' | 'base_sha'> | null;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  showToast: (t: Omit<Toast, 'id'>) => void;
  track: (event: 'space_archived', props: ArchiveTelemetry) => void;
}

/** Confirms, stops when needed and archives `space`; `true` once archived. */
export async function archiveSpaceFlow(
  deps: ArchiveDeps,
  surface: ArchiveSurface,
  space: SpaceView,
): Promise<boolean> {
  const { fleet, confirm, showToast, track } = deps;
  const id = space.space;
  const ask = archiveConfirm(space, {
    unshipped: hasUnshippedChanges(deps.row(id)),
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
}
