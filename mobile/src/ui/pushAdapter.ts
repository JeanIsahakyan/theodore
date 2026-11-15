/**
 * Notifications on/off, through `src/push/index.ts` (written by the push
 * module). The module may be absent in a tree or on a platform; then the
 * toggle is a no-op and `pushAvailable()` is false.
 */
import type { FleetClient } from '../fleet/types';

interface PushModule {
  setNotificationsEnabled?: (
    fleet: FleetClient,
    on: boolean,
  ) => Promise<void> | void;
  getNotificationsEnabled?: () => Promise<boolean> | boolean;
}

function load(): PushModule | null {
  try {
    // Optional dependency: Metro tolerates a missing module inside try/catch.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../push') as PushModule;
  } catch {
    return null;
  }
}

export const pushAvailable = (): boolean =>
  typeof load()?.setNotificationsEnabled === 'function';

export async function setNotificationsEnabled(
  fleet: FleetClient,
  on: boolean,
): Promise<void> {
  const fn = load()?.setNotificationsEnabled;
  if (fn) await fn(fleet, on);
}

/** The persisted setting when the push module can say, else `fallback`. */
export async function getNotificationsEnabled(
  fallback = false,
): Promise<boolean> {
  const fn = load()?.getNotificationsEnabled;
  if (!fn) return fallback;
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
