/** Theodore account sign-in as a pure state machine, so the flow is
 *  testable without React or the core. `useAccountSignIn` drives it.
 *
 *  idle ─start─▶ starting ─started─▶ browser ──poll done──▶ done
 *                   │                device  ──poll done──▶ done
 *                   └─failed─▶ error          ├─ denied / expired
 *                                              └─ failed ─▶ error
 *  any ─cancel─▶ idle
 */
import type {
  AccountSignInMethod,
  AccountSignInStart,
  AccountSignInState,
  AccountStatus,
  AccountUser,
} from '../gen/contract';

export type AccountFlowPhase =
  | 'idle'
  | 'starting'
  | 'browser'
  | 'device'
  | 'done'
  | 'denied'
  | 'expired'
  | 'error';

export interface DeviceCode {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresIn: number;
}

export interface AccountFlow {
  phase: AccountFlowPhase;
  method: AccountSignInMethod | null;
  /** The hosted sign-in page (browser method). */
  url: string | null;
  device: DeviceCode | null;
  /** Poll interval, seconds (device method; the browser method polls
   *  the core's in-memory outcome every second). */
  interval: number;
  error: string | null;
  status: AccountStatus | null;
  /** Bumped on every start, so a late reply to an abandoned attempt is
   *  recognised and dropped. */
  attempt: number;
  /** Bumped on every reply that keeps waiting, so the poll loop re-arms. */
  polls: number;
}

export type AccountFlowEvent =
  | { type: 'start'; method: AccountSignInMethod }
  | { type: 'started'; attempt: number; start: AccountSignInStart }
  | { type: 'poll'; attempt: number; state: AccountSignInState }
  | { type: 'failed'; attempt: number; error: string }
  | { type: 'cancel' };

export const BROWSER_POLL_MS = 1000;

export const initialFlow: AccountFlow = {
  phase: 'idle',
  method: null,
  url: null,
  device: null,
  interval: 5,
  error: null,
  status: null,
  attempt: 0,
  polls: 0,
};

/** Phases that wait on the core, and so keep polling. */
export function isWaiting(flow: AccountFlow): boolean {
  return flow.phase === 'browser' || flow.phase === 'device';
}

export function reduceFlow(
  flow: AccountFlow,
  event: AccountFlowEvent,
): AccountFlow {
  switch (event.type) {
    case 'start':
      return {
        ...initialFlow,
        phase: 'starting',
        method: event.method,
        attempt: flow.attempt + 1,
      };
    case 'cancel':
      return { ...initialFlow, attempt: flow.attempt + 1 };
    case 'started': {
      if (event.attempt !== flow.attempt || flow.phase !== 'starting') {
        return flow;
      }
      const s = event.start;
      if (s.method === 'browser') {
        return { ...flow, phase: 'browser', url: s.url };
      }
      return {
        ...flow,
        phase: 'device',
        interval: Math.max(1, s.interval),
        device: {
          userCode: s.user_code,
          verificationUri: s.verification_uri,
          verificationUriComplete: s.verification_uri_complete,
          expiresIn: s.expires_in,
        },
      };
    }
    case 'failed':
      if (event.attempt !== flow.attempt || flow.phase === 'idle') return flow;
      return { ...flow, phase: 'error', error: event.error };
    case 'poll': {
      if (event.attempt !== flow.attempt || !isWaiting(flow)) return flow;
      const s = event.state;
      switch (s.state) {
        case 'pending':
          return { ...flow, polls: flow.polls + 1 };
        case 'slow_down':
          return {
            ...flow,
            polls: flow.polls + 1,
            interval: Math.max(flow.interval, s.interval),
          };
        case 'expired':
          return { ...flow, phase: 'expired' };
        case 'denied':
          return { ...flow, phase: 'denied' };
        case 'failed':
          return { ...flow, phase: 'error', error: s.message };
        case 'done':
          return { ...flow, phase: 'done', status: s.status };
      }
    }
  }
  return flow;
}

/** Milliseconds until the next poll, or `null` when nothing is waiting. */
export function nextPollDelay(flow: AccountFlow): number | null {
  if (flow.phase === 'browser') return BROWSER_POLL_MS;
  if (flow.phase === 'device') return flow.interval * 1000;
  return null;
}

/** Name if known, else the email. */
export function accountLabel(user: AccountUser): string {
  return user.name?.trim() || user.email;
}

/** A loose check so the button only enables on something email-shaped;
 *  the hosted page does the real validation. */
export function looksLikeEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}
