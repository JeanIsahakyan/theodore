/**
 * The one toast at the bottom of the shell (zustand): a line of text and
 * an optional action ("Archived · Undo"). A new one replaces the last; it
 * hides itself after `TOAST_MS` (`src/ui/Toast.tsx` draws it).
 */
import { create } from 'zustand';

export const TOAST_MS = 6_000;

export interface Toast {
  /** Bumped per toast: the host restarts its timer. */
  id: number;
  text: string;
  action?: { label: string; onPress: () => void };
}

export interface ToastState {
  toast: Toast | null;
}

export const useToast = create<ToastState>(() => ({ toast: null }));

let counter = 0;

export function showToast(t: Omit<Toast, 'id'>): void {
  useToast.setState({ toast: { ...t, id: ++counter } });
}

/** Hides `id` (or whatever shows, when omitted). */
export function hideToast(id?: number): void {
  useToast.setState((s) =>
    s.toast && (id === undefined || s.toast.id === id) ? { toast: null } : {},
  );
}
