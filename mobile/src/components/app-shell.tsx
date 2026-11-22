// Adapted from EvanBacon/chat-template (MIT)
/**
 * The signed-in shell on iOS and Android: the drawer (spaces, Devices,
 * Settings, account) around the stack. Web: `app-shell.web.tsx` (sidebar).
 *
 * The drawer opens from the menu button, or by a rightward swipe anywhere
 * on the content of a top-level screen, Home or a space (`swipeOpensOn`).
 * Not on a pushed screen: its left edge is the system's back swipe.
 *
 * A pick closes it; a sheet opened from it (the account row) shows over it
 * and leaves it open (`useDrawerFollowsRoute`).
 */
import { usePathname, type Href } from 'expo-router';
import type { ReactNode } from 'react';
import { openFromDrawer } from '../shell/navigate';
import { swipeOpensOn } from '../ui/drawer';
import { useDrawer, useDrawerFollowsRoute } from './drawer-context';
import { DrawerContent } from './drawer-content';
import { DrawerLayout } from './drawer-layout';

export function AppShell({ children }: { children: ReactNode }) {
  const { isOpen, openDrawer, closeDrawer } = useDrawer();
  const path = usePathname();
  useDrawerFollowsRoute();
  return (
    <DrawerLayout
      open={isOpen}
      onOpen={openDrawer}
      onClose={closeDrawer}
      swipeEnabled={swipeOpensOn(path)}
      drawerContent={
        <DrawerContent
          onNavigate={(href: Href) => {
            closeDrawer();
            openFromDrawer(href, path);
          }}
        />
      }
    >
      {children}
    </DrawerLayout>
  );
}
