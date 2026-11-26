/**
 * Settings → Delete account (App Store guideline 5.1.1(v); docs/mobile.md
 * "Account deletion"). Pure: the screen passes the system confirm and the
 * auth client, so a test runs it without React Native.
 *
 * ```text
 * Delete account ─▶ system destructive confirm (what goes, what stays)
 *   cancel ─▶ nothing
 *   Delete ─▶ auth.deleteAccount() ─▶ DELETE /v1/account (docs/cloud.md)
 *     ok   ─▶ signed out here, the account's keys and stores gone
 *             ─▶ the sign-in screen: "Your account was deleted."
 *     fail ─▶ thrown: Settings says why, nothing changed, try again
 * ```
 */
import { create } from 'zustand';
import type { ConfirmOptions } from './native/types';

/** The system confirm: what goes, what stays. */
export const DELETE_ACCOUNT_CONFIRM: ConfirmOptions = {
  title: 'Delete your Theodore account?',
  message: [
    'Deleted for good: your account, organizations only you are in, your devices, fleet history and push tokens.',
    'Kept: your code and spaces on your computers, and organizations others are in (you leave them). Your GitHub and agent accounts are untouched.',
  ].join('\n\n'),
  confirmLabel: 'Delete account',
  destructive: true,
};

/** What the sign-in screen says after a deletion. */
export const ACCOUNT_DELETED_NOTICE = 'Your account was deleted.';

/** Set once a deletion went through; the sign-in screen clears it. */
export const useAccountDeleted = create<{ deleted: boolean }>(() => ({
  deleted: false,
}));

export function clearAccountDeleted(): void {
  useAccountDeleted.setState({ deleted: false });
}

export interface DeleteAccountDeps {
  confirm: (o: ConfirmOptions) => Promise<boolean>;
  auth: { deleteAccount(): Promise<void> };
}

/** Asks, then deletes. Throws when the cloud fails (nothing changed). */
export async function deleteAccountFlow(
  deps: DeleteAccountDeps,
): Promise<'cancelled' | 'deleted'> {
  if (!(await deps.confirm(DELETE_ACCOUNT_CONFIRM))) return 'cancelled';
  await deps.auth.deleteAccount();
  useAccountDeleted.setState({ deleted: true });
  return 'deleted';
}
