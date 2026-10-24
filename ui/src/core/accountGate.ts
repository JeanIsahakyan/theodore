/** The account gate (plan §6.12 "Sign-in required"), as the UI sees it.
 *  Wherever a Theodore account is configured, nothing but the sign-in
 *  shows until someone is signed in; the core turns other commands away
 *  with `account_required` too.
 *
 *  account_status ──▶ unknown (not loaded yet) ─▶ blank window
 *                     open    (not required, or signed in) ─▶ the app
 *                     locked  (required, signed out)       ─▶ sign-in
 */
import type { AccountStatus } from '../gen/contract';

export type AccountGate = 'unknown' | 'open' | 'locked';

/** The error code of a command turned away by the gate. */
export const ACCOUNT_REQUIRED = 'account_required';

/** Stands in when `account_status` itself fails: the UI stays open and
 *  the core still enforces the gate on every command. */
export const NO_ACCOUNT: AccountStatus = {
  available: false,
  required: false,
  user: null,
  session_ended: false,
};

export function accountGate(status: AccountStatus | null): AccountGate {
  if (!status) return 'unknown';
  return status.required && !status.user ? 'locked' : 'open';
}

export type AppView = 'loading' | 'onboarding' | 'sign-in' | 'app';

/** What fills the window. Onboarding starts with the sign-in step, so a
 *  first launch goes there signed out too; it can't move past that step
 *  until signed in (`Onboarding`). */
export function appView(onboarded: boolean, gate: AccountGate): AppView {
  if (gate === 'unknown') return 'loading';
  if (!onboarded) return 'onboarding';
  return gate === 'locked' ? 'sign-in' : 'app';
}

/** Native menu items that still work behind the gate: they touch neither
 *  the core's work commands nor the app's views. */
export const MENU_WHILE_LOCKED: ReadonlySet<string> = new Set([
  'check-updates',
  'report-issue',
  // Builds a local zip of logs: a broken sign-in can still be reported.
  'report-problem',
  'toggle-theme',
]);
