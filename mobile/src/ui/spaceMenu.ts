/**
 * The space menu (docs/mobile.md "Archive"): what a long press on a drawer
 * row offers. Pure, so the tests read it; the per-platform menu is
 * `src/components/space-menu{.ios,.android,}.tsx`.
 *
 * ```text
 * long press a row (iOS / Android), right-click or ⋯ (web)
 *   ─▶ ╭ ⌸ Archive ╮   only when canArchive (src/ui/archive.ts); no item ─▶ no menu
 * ```
 */
import type { SymbolName } from '../components/symbol-image';
import type { FleetDeviceView, SpaceView } from '../fleet/types';
import { canArchive } from './archive';

export type SpaceMenuItemId = 'archive';

export interface SpaceMenuItem {
  id: SpaceMenuItemId;
  label: string;
  icon: SymbolName;
  /** Drawn in the danger color, iOS `destructive` role. */
  destructive: boolean;
}

const ARCHIVE: SpaceMenuItem = {
  id: 'archive',
  label: 'Archive',
  icon: 'archive',
  destructive: true,
};

/** The menu's items for `space`; empty when nothing can be done to it here. */
export function spaceMenuItems(
  space: SpaceView,
  devices: readonly FleetDeviceView[],
): SpaceMenuItem[] {
  return canArchive(space, devices) ? [ARCHIVE] : [];
}

/** What each item runs; `archive` is `useArchive`'s flow. */
export interface SpaceMenuActions {
  archive: (space: SpaceView) => Promise<boolean>;
}

/** Runs the chosen item on `space`; `true` when it went through. */
export function runSpaceMenuItem(
  id: SpaceMenuItemId,
  space: SpaceView,
  actions: SpaceMenuActions,
): Promise<boolean> {
  switch (id) {
    case 'archive':
      return actions.archive(space);
    default:
      return Promise.resolve(false);
  }
}
