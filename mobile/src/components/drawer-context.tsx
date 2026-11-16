// Adapted from EvanBacon/chat-template (MIT)
/**
 * Whether the drawer (native) or the narrow-screen sidebar (web) is open;
 * the menu button in the header opens it, a pick in it closes it.
 */
import {
  createContext,
  use,
  useCallback,
  useState,
  type ReactNode,
} from 'react';

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
