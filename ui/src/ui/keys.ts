import { useEffect } from 'react';
import type { UiStore } from '../stores/UiStore';
import { inSequence } from './Palette';

/** Physical key → the Latin letter/digit a US layout would produce for it.
 *  `e.key` reflects the active layout (e.g. a Cyrillic character for the
 *  key physically labelled "J"), so single-letter shortcuts match on
 *  `e.code` instead — the same key works no matter what layout is active. */
const CODE_TO_LATIN: Record<string, string> = Object.fromEntries([
  ...'abcdefghijklmnopqrstuvwxyz'
    .split('')
    .map((c) => [`Key${c.toUpperCase()}`, c]),
  ...'0123456789'.split('').map((d) => [`Digit${d}`, d]),
]);

/** The shortcut letter for a keydown event, independent of keyboard layout.
 *  Falls back to `e.key` for keys with no letter/digit code (`Escape`,
 *  `Enter`, `/`, …), where layout differences don't come up in practice. */
export function latinKey(e: Pick<KeyboardEvent, 'code' | 'key'>): string {
  return CODE_TO_LATIN[e.code] ?? e.key;
}

/**
 * Single-key shortcuts for a view. Runs in the capture phase so React Aria
 * collections (ListBox typeahead, Tabs arrows) never swallow them; return
 * false from the handler to let the key through.
 */
export function useViewKeys(
  ui: UiStore,
  handler: (e: KeyboardEvent) => boolean | void,
  deps: unknown[],
) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (ui.modal || e.metaKey || e.ctrlKey || e.altKey || inSequence())
        return;
      const t = e.target as HTMLElement;
      if (t.closest('input,textarea,[role=dialog]')) return;
      if (handler(e) === false) return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
