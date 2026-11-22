/**
 * What Settings says, as plain strings (no React Native), so the wording
 * is tested and the same on iOS, Android and web.
 *
 * ```text
 * (JI) Jean Isahakyan                  accountView()
 *      jean@example.com
 *      Acme · Admin
 * Organization   Acme  ›                current org's name
 * Devices        2 online  ›            devicesSummary()
 * This device    Jean's iPhone  ›
 * Appearance     System ⌃⌄              themeLabel()
 * About          1.0.0  ›
 * ```
 */
import type { Organization, Session } from '../auth/types';
import { THEME_CHOICES, type ThemePreference } from './appearance';
import { initials } from './drawer';
import { roleLabel } from './logic';

/** "https://cloud.example.com/v1" → "cloud.example.com". */
export const serverHost = (url: string): string =>
  url.replace(/^\w+:\/\//, '').replace(/\/.*$/, '');

/** The Theme setting as its row says it ("System"). */
export const themeLabel = (theme: ThemePreference): string =>
  THEME_CHOICES.find((c) => c.value === theme)?.label ?? 'System';

/**
 * The Devices row's detail: how many of your other devices are online
 * ("2 online"); "None yet" before any other device signed in.
 */
export function devicesSummary(
  devices: readonly { online: boolean; thisDevice: boolean }[],
): string {
  const others = devices.filter((d) => !d.thisDevice);
  if (others.length === 0) return 'None yet';
  return `${others.filter((d) => d.online).length} online`;
}

/** The Accounts row's detail: how many are signed in here ("2"), none: "". */
export function accountsDetail(count: number): string {
  return count > 1 ? String(count) : '';
}

export interface AccountView {
  /** The name, else the email. */
  title: string;
  /** Under the title; null when the title is already the email. */
  email: string | null;
  initials: string;
  /** The current organization's name, once known. */
  organization: string | null;
  /** "Admin": the role in it. */
  role: string | null;
}

/** The account card at the top of Settings. */
export function accountView(
  session: Pick<Session, 'name' | 'email' | 'organizationId' | 'role'> | null,
  orgs: readonly Organization[],
): AccountView {
  const name = session?.name?.trim() || null;
  const email = session?.email ?? '';
  const current = orgs.find((o) => o.id === session?.organizationId);
  const role = current?.role ?? session?.role ?? null;
  return {
    title: name ?? (email || 'Signed in'),
    email: name && email ? email : null,
    initials: initials(name, email),
    organization: current?.name ?? null,
    role: role ? roleLabel(role) : null,
  };
}

/** The Organization page's note: the error, else what an org holds. */
export function organizationNote(
  error: string | null,
  count: number,
): string | null {
  if (error) return error;
  return count > 1
    ? 'Spaces and devices belong to the organization you are in.'
    : null;
}
