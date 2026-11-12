/** Where you are, for the fleet (docs/fleet.md "Questions go to where you
 *  are"): the core is told when the window gains or loses focus and, while
 *  it is focused, every 15 s how long ago you last typed or pointed. Only
 *  with the fleet enabled. */
import { reaction } from 'mobx';
import type { FleetPresenceRequest } from '../../gen/contract';
import { api } from '../../core/api';
import type { RootStore } from '../../stores/RootStore';

export const PRESENCE_INTERVAL_MS = 15_000;

const INPUT_EVENTS = ['keydown', 'pointerdown', 'pointermove', 'wheel'];

export interface PresenceEnv {
  enabled: () => boolean;
  report: (req: FleetPresenceRequest) => void;
  focused: () => boolean;
  now: () => number;
}

/** Wires the listeners and the timer; returns what undoes them. Input
 *  events only note the time: they never send anything. */
export function startPresence(
  env: PresenceEnv,
  target: Window = window,
): () => void {
  let lastInput = env.now();
  let timer: ReturnType<typeof setInterval> | null = null;

  const send = () => {
    if (!env.enabled()) return;
    const focused = env.focused();
    env.report({
      focused,
      idle_ms: focused ? Math.max(0, env.now() - lastInput) : 0,
    });
  };
  const stopTimer = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const startTimer = () => {
    if (timer === null) timer = setInterval(send, PRESENCE_INTERVAL_MS);
  };
  const onInput = () => {
    lastInput = env.now();
  };
  const onFocus = () => {
    lastInput = env.now();
    startTimer();
    send();
  };
  const onBlur = () => {
    stopTimer();
    send();
  };

  for (const ev of INPUT_EVENTS) {
    target.addEventListener(ev, onInput, { passive: true, capture: true });
  }
  target.addEventListener('focus', onFocus);
  target.addEventListener('blur', onBlur);
  if (env.focused()) startTimer();

  return () => {
    stopTimer();
    for (const ev of INPUT_EVENTS) {
      target.removeEventListener(ev, onInput, { capture: true });
    }
    target.removeEventListener('focus', onFocus);
    target.removeEventListener('blur', onBlur);
  };
}

/** The app's presence: starts with the fleet enabled (reporting at once),
 *  stops when it is turned off. */
export function watchPresence(store: RootStore): () => void {
  let stop: (() => void) | null = null;
  const off = reaction(
    () => store.fleet.enabled,
    (on) => {
      stop?.();
      stop = null;
      if (!on) return;
      const env: PresenceEnv = {
        enabled: () => store.fleet.enabled,
        report: (req) => void api.fleetPresence(req),
        focused: () => document.hasFocus(),
        now: () => Date.now(),
      };
      stop = startPresence(env);
      // Where you are right now, without waiting for the first tick.
      env.report({ focused: env.focused(), idle_ms: 0 });
    },
    { fireImmediately: true },
  );
  return () => {
    off();
    stop?.();
  };
}
