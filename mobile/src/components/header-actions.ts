/**
 * What the main header's buttons do, the same on every platform:
 *
 * ```text
 * ☰  menu        ─▶ opens the drawer (native) / the sidebar (narrow web)
 * ✎  new space   ─▶ back to Home
 * ```
 *
 * No screen-specific buttons: a space's Archive is in the drawer row's
 * long-press menu (docs/mobile.md "Archive"), so the title keeps its room.
 * Questions waiting for you are in the drawer ("Waiting for you · N", its
 * space rows' dots) and on Home, not here.
 */
import { usePathname } from 'expo-router';
import { useCallback } from 'react';
import { goNewSpace } from '../shell/navigate';
import { useDrawer } from './drawer-context';

export interface MainHeaderProps {
  title: string;
  /** A space's second line ("on mac-A · Running"), under the title. */
  subtitle?: string;
  /** What "new space" does on Home itself (clear the draft); elsewhere it
   *  goes to Home. */
  onNewSpace?: () => void;
}

export function useHeaderActions(onNewSpace?: () => void) {
  const { openDrawer } = useDrawer();
  const path = usePathname();
  const newSpace = useCallback(() => {
    if (path === '/') onNewSpace?.();
    else goNewSpace(path);
  }, [path, onNewSpace]);
  return { openDrawer, newSpace };
}
