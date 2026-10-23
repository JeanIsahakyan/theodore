import { isTauri } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';

/** Opens a link in the default browser. In the desktop window
 *  `window.open` opens nothing, so it goes through the shell's opener;
 *  in a plain browser (tests, dev in a tab) it stays `window.open`. */
export function openExternal(url: string): void {
  if (isTauri()) {
    void openUrl(url).catch(() => window.open(url, '_blank'));
  } else {
    window.open(url, '_blank');
  }
}
