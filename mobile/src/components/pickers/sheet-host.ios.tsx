/**
 * iOS: a sheet is a route the stack presents as a formSheet (medium /
 * large detents, a grabber, Liquid Glass on iOS 26+, `app/(app)/_layout.tsx`);
 * nothing to render in place.
 */
import { router, type Href } from 'expo-router';
import { useRef } from 'react';
import { track } from '../../telemetry/log';
import type { SheetHandle, SheetKind } from './types';

const PATHS: Record<SheetKind, string> = {
  model: '/model-picker',
  computer: '/computer-picker',
  project: '/project-picker',
  activity: '/activity-sheet',
};

export function sheetHref(kind: SheetKind, space?: string | null): Href {
  const path = PATHS[kind];
  return (space ? `${path}?space=${encodeURIComponent(space)}` : path) as Href;
}

export function useSheet(kind: SheetKind, space?: string | null): SheetHandle {
  // One sheet per tap burst.
  const last = useRef(0);
  return {
    open: () => {
      const now = Date.now();
      if (now - last.current < 600) return;
      last.current = now;
      track('sheet_opened', { kind });
      router.push(sheetHref(kind, space));
    },
    isOpen: false,
    element: null,
  };
}
