/**
 * What the connection banner says, and when. A normal (re)connect — the app
 * coming back from the background on iOS, a network switch — takes well
 * under a second and shows nothing; "Connecting…" appears only once the
 * fleet has been trying for `CONNECTING_GRACE_MS`.
 *
 * ```text
 * connected ─▶ connecting ─(< 1.5 s)─▶ connected     nothing shown
 * connected ─▶ connecting ─(1.5 s)──▶ "Connecting…" ─▶ connected ─▶ gone
 * error                              ─▶ shown at once (it does not fix itself)
 * off                                ─▶ nothing (signed out, in the background)
 * ```
 */
import type { ConnectionState } from '../fleet/types';
import type { Tone } from './logic';

export const CONNECTING_GRACE_MS = 1500;

export interface BannerView {
  tone: Tone;
  text: string;
  /** A spinner beside the text. */
  busy: boolean;
}

export function connectionBanner(
  connection: ConnectionState,
  error: string | null,
  late: boolean,
): BannerView | null {
  if (connection === 'connecting') {
    return late
      ? { tone: 'neutral', text: 'Connecting to your devices…', busy: true }
      : null;
  }
  if (connection === 'error') {
    return {
      tone: 'danger',
      text: error ? `Not connected: ${error}` : 'Not connected.',
      busy: false,
    };
  }
  return null;
}

/**
 * Says `late = true` once `connecting` has lasted `graceMs`, `false` as
 * soon as it is anything else. The banner's hook drives it with the store.
 */
export function lateConnecting(
  onLate: (late: boolean) => void,
  graceMs = CONNECTING_GRACE_MS,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let late = false;
  const set = (v: boolean) => {
    if (v !== late) {
      late = v;
      onLate(v);
    }
  };
  return {
    update(connection: ConnectionState) {
      if (connection === 'connecting') {
        timer ??= setTimeout(() => {
          timer = null;
          set(true);
        }, graceMs);
        return;
      }
      if (timer) clearTimeout(timer);
      timer = null;
      set(false);
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
