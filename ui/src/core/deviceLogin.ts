/** Drives GitHub's OAuth device flow end to end (`login_start`, then
 *  `login_poll` at the host's own cadence) so Onboarding and Settings →
 *  Account don't each reinvent it. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, CommandFailure } from './api';
import type { DeviceLogin, HostAuthStatus } from '../gen/contract';

export type DeviceLoginPhase =
  'idle' | 'starting' | 'pending' | 'denied' | 'expired' | 'error';

export interface DeviceLoginState {
  /** Whether the shell has a client id configured; the caller hides the
   *  "Sign in with GitHub" button when this is false. */
  available: boolean;
  phase: DeviceLoginPhase;
  device: DeviceLogin | null;
  error: string | null;
  start: () => void;
  reset: () => void;
}

function message(e: unknown): string {
  return e instanceof CommandFailure ? e.message : String(e);
}

export function useDeviceLogin(
  onDone: (status: HostAuthStatus) => void,
): DeviceLoginState {
  const [available, setAvailable] = useState(false);
  const [phase, setPhase] = useState<DeviceLoginPhase>('idle');
  const [device, setDevice] = useState<DeviceLogin | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped by `start()` so the polling effect below always restarts on a
  // fresh device code, even one with the same `interval` as the last.
  const [session, setSession] = useState(0);

  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    void api
      .hostStatus()
      .then((s) => setAvailable(s.device_login_available ?? false))
      .catch(() => setAvailable(false));
  }, []);

  // One polling chain per `(phase === 'pending', device)` pair: a plain
  // recursive `setTimeout`, not a hook value, so it can call itself without
  // tripping the hooks rule against self-referential hook bindings.
  useEffect(() => {
    if (phase !== 'pending' || !device) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = (intervalMs: number) => {
      timer = setTimeout(async () => {
        try {
          const s = await api.loginPoll();
          if (cancelled) return;
          switch (s.state) {
            case 'pending':
              poll(intervalMs);
              break;
            case 'slow_down':
              poll(s.interval * 1000);
              break;
            case 'expired':
              setPhase('expired');
              break;
            case 'denied':
              setPhase('denied');
              break;
            case 'done':
              setDevice(null);
              onDoneRef.current(s.status);
              break;
          }
        } catch (e) {
          if (cancelled) return;
          setPhase('error');
          setError(message(e));
        }
      }, intervalMs);
    };
    poll(device.interval * 1000);

    return () => {
      cancelled = true;
      if (timer != null) clearTimeout(timer);
    };
    // `session` isn't read above; it only forces a restart on a fresh
    // `start()` even when the new device code has the same `interval`.
  }, [phase, device, session]);

  const start = useCallback(() => {
    setError(null);
    setPhase('starting');
    void api
      .loginStart()
      .then((d) => {
        setDevice(d);
        setSession((n) => n + 1);
        setPhase('pending');
      })
      .catch((e) => {
        setPhase('error');
        setError(message(e));
      });
  }, []);

  const reset = useCallback(() => {
    setDevice(null);
    setError(null);
    setPhase('idle');
  }, []);

  return { available, phase, device, error, start, reset };
}
