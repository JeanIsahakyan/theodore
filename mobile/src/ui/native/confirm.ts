/**
 * Web: the browser's own dialog (`window.confirm` / `window.alert`); React
 * Native's `Alert` does nothing there.
 */
import type { ConfirmOptions } from './types';

const text = (title: string, message?: string) =>
  message ? `${title}\n\n${message}` : title;

/** Resolves `true` when the confirm action is taken, `false` otherwise. */
export function confirm({ title, message }: ConfirmOptions): Promise<boolean> {
  if (typeof window === 'undefined' || !window.confirm) {
    return Promise.resolve(false);
  }
  return Promise.resolve(window.confirm(text(title, message)));
}

/** A message with one OK button. */
export function notify(title: string, message?: string): Promise<void> {
  if (typeof window !== 'undefined' && window.alert) {
    window.alert(text(title, message));
  }
  return Promise.resolve();
}
