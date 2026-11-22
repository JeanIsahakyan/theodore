// Adapted from EvanBacon/chat-template (MIT)
/**
 * Web: the sidebar (the drawer's content) beside the stack.
 *
 * ```text
 * wide (md+)   [ sidebar 280 ][ content, inset panel with a rounded corner ]
 * narrow       [ content ]   ☰ ─▶ the sidebar slides over it, a scrim behind
 * ```
 */
import { usePathname, type Href } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { openFromDrawer } from '../shell/navigate';
import { useDrawer, useDrawerFollowsRoute } from './drawer-context';
import { DrawerContent } from './drawer-content';

const EASE = '0.3s cubic-bezier(0.32, 0.72, 0, 1)';

export function AppShell({ children }: { children: ReactNode }) {
  const { isOpen, closeDrawer } = useDrawer();
  const path = usePathname();
  useDrawerFollowsRoute();
  return (
    <View className="h-dvh w-full flex-row bg-sidebar">
      <Pressable
        onPress={closeDrawer}
        accessibilityLabel="Close menu"
        aria-hidden={!isOpen}
        className={`fixed inset-0 z-40 bg-black/30 md:hidden ${isOpen ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        style={{ transition: `opacity ${EASE}` } as object}
      />
      <View
        className={`fixed top-0 left-0 z-50 h-dvh w-[280px] bg-sidebar md:relative md:z-auto md:translate-x-0 ${isOpen ? 'translate-x-0' : '-translate-x-full'}`}
        style={{ transition: `translate ${EASE}` } as object}
      >
        <DrawerContent
          edges={[]}
          onNavigate={(href: Href) => {
            closeDrawer();
            openFromDrawer(href, path);
          }}
        />
      </View>
      <View className="min-w-0 flex-1 overflow-hidden bg-background md:mt-2 md:rounded-tl-xl md:border-t md:border-l md:border-border">
        {children}
      </View>
    </View>
  );
}
