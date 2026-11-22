/**
 * The first connection of an app run (docs/mobile.md "First connection"):
 * until the fleet's first `devices` list arrives, nothing listed means
 * "not loaded yet", not "nothing there". Home and the drawer draw
 * skeletons then, never the empty states.
 *
 * ```text
 * connecting, no welcome yet ─(< 10 s)─▶ loading       skeletons, "Connecting to your devices…"
 *                            ─(10 s)───▶ unreachable   "Can't reach the server" + Retry
 * error, no welcome yet      ──────────▶ unreachable
 * welcome + devices          ──────────▶ ready         the list (Home: or "No computer…")
 * welcomed ─▶ connecting (a redial)      ready         the last list stays, the banner speaks
 * ```
 *
 * `late` comes from `lateConnecting(onLate, UNREACHABLE_AFTER_MS)`
 * (`./connection.ts`): `connecting` has lasted that long in a row.
 */
import type { ConnectionState, SpaceView } from '../fleet/types';
import type { HomeDraft } from './homeDraft';

/** `connecting` without a welcome for this long reads as unreachable. */
export const UNREACHABLE_AFTER_MS = 10_000;

export type LoadState = 'loading' | 'ready' | 'unreachable';

export function loadState(
  connection: ConnectionState,
  welcomed: boolean,
  late: boolean,
): LoadState {
  if (welcomed) return 'ready';
  if (connection === 'error') return 'unreachable';
  if (connection === 'connecting' && late) return 'unreachable';
  return 'loading';
}

export type HomeLoadState = LoadState | 'empty';

/** Home's: `empty` once the fleet answered and no computer can take a space. */
export function homeLoadState(
  connection: ConnectionState,
  welcomed: boolean,
  startable: boolean,
  late: boolean,
): HomeLoadState {
  const s = loadState(connection, welcomed, late);
  return s === 'ready' && !startable ? 'empty' : s;
}

export const UNREACHABLE_TITLE = "Can't reach the server";
export const UNREACHABLE_HINT = 'Check your connection and try again.';
export const LOADING_TEXT = 'Connecting to your devices…';

/**
 * The loading line: "Switching to Acme Inc…" while an account or org
 * switch is under way (`src/state/accounts.ts`), else the first
 * connection's text.
 */
export function loadingText(switching: string | null): string {
  return switching ? `Switching to ${switching}…` : LOADING_TEXT;
}

/** What the unreachable state says under its title: the fleet's reason, else a hint. */
export function unreachableHint(error: string | null): string {
  return error ? error : UNREACHABLE_HINT;
}

export interface LastPicksPreview {
  /** The last picked computer's name. */
  host: string | null;
  /** The project the last space on it was started in. */
  project: string | null;
}

/**
 * The last picks as muted chips while the devices haven't answered yet,
 * named from the spaces saved from the last run (a pick keeps only ids):
 * the host of any saved space on the picked computer, and the project of
 * the most recently active one started here (a start picks its project).
 * None saved on it: skeleton chips.
 */
export function lastPicksPreview(
  draft: HomeDraft,
  saved: readonly SpaceView[],
): LastPicksPreview {
  if (!draft.deviceId) return { host: null, project: null };
  const on = saved.filter((s) => s.hostDevice === draft.deviceId);
  const host = on.find((s) => s.hostName)?.hostName ?? null;
  if (!host) return { host: null, project: null };
  const mine = on
    .filter((s) => s.startedHere && s.projectName)
    .sort((a, b) => (b.activeAt ?? 0) - (a.activeAt ?? 0));
  return { host, project: mine[0]?.projectName ?? null };
}
