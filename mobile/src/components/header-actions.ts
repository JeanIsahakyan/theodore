/**
 * What the main header's buttons do, the same on every platform:
 *
 * ```text
 * ☰  menu        ─▶ opens the drawer (native) / the sidebar (narrow web)
 * 🔔 questions   ─▶ only while one waits: its space (the question card is there)
 * ✎  new space   ─▶ back to Home
 * ⌸  actions     ─▶ a screen's own icon buttons, after ✎ (a space's Archive)
 * ```
 */
import { usePathname } from 'expo-router';
import { useCallback } from 'react';
import { goNewSpace, openFromDrawer, spaceHref } from '../shell/navigate';
import { useFleetState } from '../state/fleet';
import { useDrawer } from './drawer-context';
import type { SymbolName } from './symbol-image';

export interface MainHeaderProps {
  title: string;
  /** A space's second line ("on mac-A · Running"), under the title. */
  subtitle?: string;
  /** What "new space" does on Home itself (clear the draft); elsewhere it
   *  goes to Home. */
  onNewSpace?: () => void;
  /** The screen's own icon buttons, right of ✎; none or empty: nothing. */
  actions?: HeaderAction[];
}

/** One icon button of a screen's own in the header. */
export interface HeaderAction {
  icon: SymbolName;
  /** Its accessible name ("Archive space"). */
  label: string;
  onPress: () => void;
  /** In the danger color. */
  destructive?: boolean;
}

export function useHeaderActions(onNewSpace?: () => void) {
  const { openDrawer } = useDrawer();
  const path = usePathname();
  const questions = useFleetState((s) => s.questions);
  const first = questions[0]?.space ?? null;
  const newSpace = useCallback(() => {
    if (path === '/') onNewSpace?.();
    else goNewSpace(path);
  }, [path, onNewSpace]);
  const openQuestions = useCallback(() => {
    if (first) openFromDrawer(spaceHref(first), path);
  }, [first, path]);
  return {
    openDrawer,
    newSpace,
    /** Questions waiting for an answer here. */
    waiting: questions.length,
    openQuestions,
  };
}
