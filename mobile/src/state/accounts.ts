/**
 * The account switch under way (zustand), for Home's first-connection
 * state and the connection banner: "Switching to Acme Inc…" instead of
 * "Connecting to your devices…" until the fleet is welcomed as the new
 * account and org (or fails).
 *
 * ```text
 * a tap in the accounts sheet ─▶ setSwitching("Acme Inc") ─▶ the session changes
 *   ─▶ fleet: connecting (welcomed false) ─▶ Home: "Switching to Acme Inc…"
 *   ─▶ welcomed, or error ─▶ cleared (AppProviders watches the fleet store)
 * the switch fails before the session changes ─▶ cleared by the sheet
 * ```
 */
import { create } from 'zustand';

export interface AccountSwitchState {
  /** The target's name ("Acme Inc", "Jean · Personal"); `null`: none. */
  switching: string | null;
}

export const useAccountSwitch = create<AccountSwitchState>(() => ({
  switching: null,
}));

export function setSwitching(target: string | null): void {
  useAccountSwitch.setState({ switching: target });
}
