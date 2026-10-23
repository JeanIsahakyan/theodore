/** Native notifications and the dock badge, through the desktop shell.
 *  Outside the desktop window (tests, dev in a browser tab) both are
 *  no-ops, like `openExternal`'s fallback. */
import { isTauri } from '@tauri-apps/api/core';

let permission: Promise<boolean> | null = null;

/** Asks once per session; macOS remembers the answer. */
function allowed(): Promise<boolean> {
  permission ??= (async () => {
    const { isPermissionGranted, requestPermission } =
      await import('@tauri-apps/plugin-notification');
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === 'granted';
  })().catch(() => false);
  return permission;
}

export async function notify(title: string, body?: string): Promise<void> {
  if (!isTauri() || !(await allowed())) return;
  const { sendNotification } = await import('@tauri-apps/plugin-notification');
  sendNotification(body ? { title, body } : { title });
}

/** The number on the app's dock icon; 0 clears it. */
export async function setBadge(count: number): Promise<void> {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().setBadgeCount(count > 0 ? count : undefined);
}
