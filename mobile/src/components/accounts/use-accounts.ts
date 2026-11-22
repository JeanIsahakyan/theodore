/**
 * The accounts sheet's state and actions (docs/mobile.md "Several
 * accounts"), shared by the React Native list (iOS route, web modal) and
 * the Compose sheet (Android).
 *
 * ```text
 * open ─▶ the accounts, the orgs of each listed again (names for the rows);
 *   from the drawer's account row the drawer stays open under the sheet
 * an org tapped ─▶ "Switching to <org>…", the sheet and the drawer close,
 *   switchTo(user, org)
 *   refused ─▶ the switching state cleared, the error shown
 * Add another account ─▶ the normal sign-in ─▶ joins the list, active, closes
 *   several orgs ─▶ the Organization step: a row per org ─▶ chooseOrganization
 * Sign in again ─▶ the same sign-in, the email as the hint; replaces the account
 * Sign out of <active> ─▶ confirm ─▶ signOut: the next account takes over
 * ```
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type {
  AccountView,
  OrganizationChoice,
  SignInResult,
} from '../../auth/types';
import { useServices } from '../../services';
import { useAuthState } from '../../shell/AppProviders';
import { setSwitching } from '../../state/accounts';
import {
  accountsRows,
  signOutPrompt,
  switchTarget,
  type AccountsRow,
} from '../../ui/accountsSheet';
import { errorText, switchErrorText } from '../../ui/logic';
import { confirm } from '../../ui/native';
import { useDrawer } from '../drawer-context';

/** The accounts signed in here, kept current. */
export function useAccounts(): AccountView[] {
  const { accounts } = useServices();
  // The list is a fresh array on every call: a snapshot is kept per change.
  const [snapshot] = useState(() => {
    let last = accounts.accounts();
    return {
      subscribe: (onChange: () => void) =>
        accounts.onAccountsChange((next) => {
          last = next;
          onChange();
        }),
      get: () => last,
    };
  });
  return useSyncExternalStore(snapshot.subscribe, snapshot.get, snapshot.get);
}

export type AccountsStep =
  | { kind: 'list' }
  /** A sign-in that needs an organization picked. */
  | { kind: 'choose'; organizations: OrganizationChoice[] };

export interface AccountsSheet {
  rows: AccountsRow[];
  step: AccountsStep;
  /** A row's id while its action runs (`add`, a user id, an org id). */
  busy: string | null;
  error: string | null;
  switchTo(row: Extract<AccountsRow, { kind: 'org' }>): void;
  add(): void;
  signInAgain(userId: string): void;
  chooseOrganization(id: string): void;
  backToList(): void;
  signOut(): void;
}

export function useAccountsSheet(onClose: () => void): AccountsSheet {
  const { auth, accounts } = useServices();
  const { session } = useAuthState();
  // The sheet opened from the drawer's account row left the drawer open: a
  // switch is the one pick that closes it.
  const { closeDrawer } = useDrawer();
  const list = useAccounts();
  const [step, setStep] = useState<AccountsStep>({ kind: 'list' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The org names, from the cloud, for every account that can ask.
  useEffect(() => {
    for (const a of accounts.accounts()) {
      if (a.stale) continue;
      accounts.loadOrganizations(a.userId).catch(() => {
        // the rows show what the index knows
      });
    }
  }, [accounts]);

  const rows = accountsRows(list, session?.organizationId ?? null);

  const finishSignIn = useCallback(
    (r: SignInResult) => {
      switch (r.kind) {
        case 'signed_in':
          closeDrawer();
          onClose();
          break;
        case 'choose_organization':
          setStep({ kind: 'choose', organizations: r.organizations });
          break;
        case 'failed':
          setError(r.message);
          setStep({ kind: 'list' });
          break;
        default:
          setStep({ kind: 'list' });
      }
    },
    [onClose, closeDrawer],
  );

  const run = (id: string, task: () => Promise<void>) => {
    if (busy) return;
    setBusy(id);
    setError(null);
    task()
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(null));
  };

  return {
    rows,
    step,
    busy,
    error,
    switchTo(row) {
      if (busy || row.selected) return;
      const account = list.find((a) => a.userId === row.userId);
      const target = switchTarget(account ?? { label: 'account' }, row.name);
      setSwitching(target);
      setBusy(row.orgId);
      setError(null);
      closeDrawer();
      accounts
        .switchTo(row.userId, row.orgId)
        .then(() => onClose())
        .catch((e: unknown) => {
          setSwitching(null);
          setError(switchErrorText(errorText(e)));
        })
        .finally(() => setBusy(null));
    },
    add() {
      // Not async before the sign-in: on the web the popup must open in
      // the press's own task.
      if (busy) return;
      setBusy('add');
      setError(null);
      accounts
        .addAccount()
        .then(finishSignIn, (e: unknown) => setError(errorText(e)))
        .finally(() => setBusy(null));
    },
    signInAgain(userId) {
      if (busy) return;
      setBusy(userId);
      setError(null);
      accounts
        .signInAgain(userId)
        .then(finishSignIn, (e: unknown) => setError(errorText(e)))
        .finally(() => setBusy(null));
    },
    chooseOrganization(id) {
      run(id, async () => finishSignIn(await auth.chooseOrganization(id)));
    },
    backToList() {
      setStep({ kind: 'list' });
    },
    signOut() {
      const active = list.find((a) => a.active);
      if (!active) return;
      run(active.userId, async () => {
        const ok = await confirm({
          ...signOutPrompt(active.label),
          destructive: true,
        });
        if (!ok) return;
        const next = list.find((a) => !a.active && !a.stale);
        if (next) setSwitching(next.label);
        closeDrawer();
        await auth.signOut();
        onClose();
      });
    },
  };
}
