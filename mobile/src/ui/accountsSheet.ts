/**
 * The accounts sheet's rows (docs/mobile.md "Several accounts"), as plain
 * data, so the wording is tested and the same on iOS, Android and web.
 *
 * ```text
 * Accounts
 * (JI) Jean                        account: avatar, name, email under it
 *      Personal              ✓     org: tap ─▶ switch to that account and org
 *      Acme Studio
 * (JA) jean@acme.com
 *      Sign in again                its refresh was rejected: sign in (login_hint)
 * + Add another account
 * ───
 * Sign out of Jean                  the active account only
 * ```
 */
import type { AccountView, OrganizationChoice } from '../auth/types';

export type AccountsRow =
  | {
      kind: 'account';
      userId: string;
      label: string;
      initials: string;
      /** Under the label; `null` when the label is the email already. */
      email: string | null;
      active: boolean;
      stale: boolean;
    }
  | {
      kind: 'org';
      userId: string;
      orgId: string;
      name: string;
      /** The active account's current org. */
      selected: boolean;
      accessibilityLabel: string;
    }
  | { kind: 'reauth'; userId: string; label: string }
  | { kind: 'add'; label: string }
  | { kind: 'sign-out'; userId: string; label: string };

export const ADD_ACCOUNT = 'Add another account';
export const SIGN_IN_AGAIN = 'Sign in again';
export const SHEET_TITLE = 'Accounts';
export const CHOOSE_TITLE = 'Organization';
export const CHOOSE_LEAD =
  'This account is in several organizations. Pick the one to use first; you can switch any time.';

/** The organizations shown under an account: the listed ones, else the one
 *  it is in (unnamed until the cloud lists it). */
export function accountOrgs(a: AccountView): OrganizationChoice[] {
  if (a.orgs.length) return a.orgs;
  return a.orgId ? [{ id: a.orgId, name: '' }] : [];
}

export function accountsRows(
  accounts: readonly AccountView[],
  activeOrg: string | null,
): AccountsRow[] {
  const rows: AccountsRow[] = [];
  for (const a of accounts) {
    rows.push({
      kind: 'account',
      userId: a.userId,
      label: a.label,
      initials: a.initials,
      email: a.email && a.email !== a.label ? a.email : null,
      active: a.active,
      stale: a.stale,
    });
    if (a.stale) {
      rows.push({ kind: 'reauth', userId: a.userId, label: SIGN_IN_AGAIN });
      continue;
    }
    for (const o of accountOrgs(a)) {
      const name = o.name || 'Organization';
      rows.push({
        kind: 'org',
        userId: a.userId,
        orgId: o.id,
        name,
        selected: a.active && o.id === activeOrg,
        accessibilityLabel: `Switch to ${name} of ${a.label}`,
      });
    }
  }
  rows.push({ kind: 'add', label: ADD_ACCOUNT });
  const active = accounts.find((a) => a.active);
  if (active) {
    rows.push({
      kind: 'sign-out',
      userId: active.userId,
      label: `Sign out of ${active.label}`,
    });
  }
  return rows;
}

/** What Home says while the switch lands: the org's name, else the account's. */
export function switchTarget(
  account: Pick<AccountView, 'label'>,
  orgName: string,
): string {
  return orgName && orgName !== 'Organization' ? orgName : account.label;
}

/** The sign-out confirm, for the active account. */
export function signOutPrompt(label: string): {
  title: string;
  message: string;
  confirmLabel: string;
} {
  return {
    title: `Sign out of ${label} on this device?`,
    message:
      'Spaces keep running on your computers. Other accounts signed in here stay.',
    confirmLabel: 'Sign out',
  };
}
