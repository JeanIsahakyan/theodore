/**
 * What the main header's buttons do, the same on every platform:
 *
 * ```text
 * ☰  menu        ─▶ opens the drawer (native) / the sidebar (narrow web)
 * 🔔 questions   ─▶ only while one waits: its space (the question card is there)
 * ✎  new space   ─▶ back to Home
 * ```
 */
import { usePathname } from 'expo-router';
import { useCallback } from 'react';
import { goNewSpace, openFromDrawer, spaceHref } from '../shell/navigate';
import { useFleetState } from '../state/fleet';
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
