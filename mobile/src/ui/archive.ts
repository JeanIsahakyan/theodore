/**
 * Archiving a space from the phone (docs/mobile.md "Archive"): who may, the
 * confirm's words, what the refusals say. Pure, so the tests read it.
 *
 * ```text
 * canArchive   host listed and trusted here (else nothing can be signed to it)
 *              ∧ started here  ∨  (followed ∧ the host takes remote requests)
 *              ∧ status ≠ starting
 * confirm      Archive “<title>”?
 *              [The agent is still working: it is stopped first. ]
 *              Its worktree is removed; the branch and PR stay.
 *              [ It has changes that were not pushed or merged.]
 *              (Stop and archive | Archive)
 * unshipped    no pr, no shipped, head_sha ≠ base_sha   (no row: false)
 * ```
 */
import type { Space } from '../fleet/contract';
import type { FleetDeviceView, SpaceView } from '../fleet/types';
import { canStop, errorText, fleetCode, spaceTitle } from './logic';

/**
 * Whether Archive is offered for `space`. The host decides for real (its
 * trust in this phone isn't known here): a followed space on a host that
 * takes remote requests shows it, and the host's refusal is the hint.
 */
export function canArchive(
  space: SpaceView,
  devices: readonly FleetDeviceView[],
): boolean {
  if (!space.hostDevice || space.status === 'starting') return false;
  const host = devices.find((d) => d.deviceId === space.hostDevice);
  if (!host?.trusted) return false;
  return space.startedHere || host.acceptsRemote;
}

/**
 * The mirrored row has work nothing shipped: no PR, never pushed / merged /
 * kept, and a checkpoint past the fork. No row: unknown, so `false`.
 */
export function hasUnshippedChanges(
  row: Pick<Space, 'pr' | 'shipped' | 'head_sha' | 'base_sha'> | null,
): boolean {
  if (!row) return false;
  if (row.pr || row.shipped) return false;
  return row.head_sha !== '' && row.head_sha !== row.base_sha;
}

export interface ArchiveConfirm {
  title: string;
  message: string;
  confirmLabel: string;
  /** The space runs: Stop goes first. */
  stopFirst: boolean;
}

export function archiveConfirm(
  space: SpaceView,
  opts: { unshipped: boolean },
): ArchiveConfirm {
  const title = spaceTitle(space) || 'Untitled space';
  const stopFirst = canStop(space.status);
  const parts = [
    stopFirst ? 'The agent is still working: it is stopped first.' : null,
    'Its worktree is removed; the branch and PR stay.',
    opts.unshipped ? 'It has changes that were not pushed or merged.' : null,
  ].filter((s): s is string => s !== null);
  return {
    title: `Archive “${title}”?`,
    message: parts.join(' '),
    confirmLabel: stopFirst ? 'Stop and archive' : 'Archive',
    stopFirst,
  };
}

/** A failed archive, by its refusal code; `errorText` for the rest. */
export function archiveErrorText(e: unknown, hostName: string): string {
  switch (fleetCode(e)) {
    case 'fleet.upgrade_required':
      return `Update Theodore on ${hostName} to archive from here`;
    case 'fleet.busy':
      return 'Stop the space first, then archive it.';
    default:
      return errorText(e);
  }
}
