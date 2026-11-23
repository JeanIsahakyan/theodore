// Adapted from EvanBacon/chat-template (MIT)
/**
 * Whether the drawer (native) or the narrow-screen sidebar (web) is open;
 * the menu button in the header opens it, a pick in it closes it. The
 * shell also closes it when the route changes to a page, not to a sheet
 * (`drawerClosesOn`, src/ui/drawer.ts): a sheet opened from the drawer
 * shows over it, and the drawer is still there when the sheet goes.
 */
import { usePathname } from 'expo-router';
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { drawerClosesOn } from '../ui/drawer';

interface DrawerContextValue {
  isOpen: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
}

const DrawerContext = createContext<DrawerContextValue | null>(null);

export function DrawerProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const openDrawer = useCallback(() => setIsOpen(true), []);
  const closeDrawer = useCallback(() => setIsOpen(false), []);
  return (
    <DrawerContext value={{ isOpen, openDrawer, closeDrawer }}>
      {children}
    </DrawerContext>
  );
}

export function useDrawer(): DrawerContextValue {
  const context = use(DrawerContext);
  if (!context) throw new Error('useDrawer outside DrawerProvider');
  return context;
}

/** In the shell: a route change to a page closes the drawer, one to or
 *  from a sheet leaves it. */
export function useDrawerFollowsRoute(): void {
  const { closeDrawer } = useDrawer();
  const path = usePathname();
  const last = useRef(path);
  useEffect(() => {
    const from = last.current;
    last.current = path;
    if (drawerClosesOn(from, path)) closeDrawer();
  }, [path, closeDrawer]);
}
