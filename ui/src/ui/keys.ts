import { useEffect } from 'react';
import type { UiStore } from '../stores/UiStore';
import { inSequence } from './Palette';

export { latinKey } from './latin';

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
      // Typing goes to the field. A switch or checkbox is an <input> too,
      // but nothing is typed there: Esc and page keys still work after
      // flipping one.
      const typing =
        t.closest('textarea,[role=dialog],[contenteditable=true]') ||
        (t instanceof HTMLInputElement &&
          !['checkbox', 'radio', 'button', 'range'].includes(t.type));
      if (typing) return;
      if (handler(e) === false) return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
