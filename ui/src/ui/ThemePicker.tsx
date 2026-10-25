import { useSyncExternalStore, type ReactNode } from 'react';
import { Display, Moon, Sun } from '@gravity-ui/icons';
import {
  THEME_EVENT,
  setThemePref,
  themePref,
  type ThemePref,
} from '../stores/UiStore';

const CHOICES: { id: ThemePref; label: string; icon: ReactNode }[] = [
  { id: 'system', label: 'System', icon: <Display className="size-5" /> },
  { id: 'light', label: 'Light', icon: <Sun className="size-5" /> },
  { id: 'dark', label: 'Dark', icon: <Moon className="size-5" /> },
];

const subscribe = (cb: () => void) => {
  window.addEventListener(THEME_EVENT, cb);
  return () => window.removeEventListener(THEME_EVENT, cb);
};

/** System / Light / Dark, as three cards; "System" follows macOS. Used in
 *  Settings → Appearance and the onboarding's theme step. */
export function ThemePicker() {
  const pref = useSyncExternalStore(subscribe, themePref);
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="grid grid-cols-3 gap-2"
    >
      {CHOICES.map((c) => {
        const on = pref === c.id;
        return (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => setThemePref(c.id)}
            className={`flex flex-col items-center gap-2 rounded-2xl border px-3 py-4 text-sm transition-colors ${
              on
                ? 'border-accent bg-accent-soft font-medium text-accent'
                : 'border-separator bg-surface text-foreground hover:bg-default'
            }`}
          >
            {c.icon}
            {c.label}
          </button>
        );
      })}
    </div>
  );
}
