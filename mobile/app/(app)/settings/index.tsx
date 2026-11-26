// Adapted from EvanBacon/chat-template (MIT)
/**
 * Settings, the template's flat page: an account card, then icon rows;
 * a row with "›" opens its page (docs/mobile.md "Settings and Devices").
 *
 * ```text
 * (JI) Jean · jean@example.com · Acme · Admin      the active account
 * Accounts       2           › ─▶ the Accounts sheet (switch, add, sign out)
 * Organization   Acme        › ─▶ settings/organization (switch)
 * Devices        2 online    › ─▶ devices
 * This device    Jean's iPhone › ─▶ settings/device (fingerprint, copy)
 * ──────────
 * Appearance     System ⌃⌄     native menu ─▶ applied app-wide, kept
 * Notifications  (  ●)         haptic tick
 * ──────────
 * Privacy
 * Share usage data   (  ●)     each switch its own sink (docs/telemetry.md)
 * Send error reports (  ●)
 * What's collected            › ─▶ settings/collected (the event catalog)
 * ──────────
 * About          1.0.0       › ─▶ settings/about (version, server)
 * ──────────
 * ⇥ Sign out (red)  ─▶ system confirm ─▶ signed out
 * ✕ Delete account (red) ─▶ system confirm (what goes, what stays)
 *     ─▶ cloud deletes ─▶ signed out ─▶ sign-in: "Your account was deleted."
 *     (src/ui/deleteAccount.ts)
 * ```
 */
import Constants from 'expo-constants';
import { useEffect, useMemo, useState } from 'react';
import type { Href } from 'expo-router';
import {
  AccountCard,
  PrivacyRows,
  SectionDivider,
  SectionNote,
  SettingsMenuRow,
  SettingsRow,
  SettingsScroll,
  SettingsToggleRow,
  kindSymbol,
  useOrganizations,
} from '../../../src/components/settings';
import { useAccounts } from '../../../src/components/accounts/use-accounts';
import { useSheet } from '../../../src/components/pickers/sheet-host';
import { useServices } from '../../../src/services';
import { useAuthState } from '../../../src/shell/AppProviders';
import { useFleetState } from '../../../src/state/fleet';
import { THEME_CHOICES } from '../../../src/ui/appearance';
import { log } from '../../../src/telemetry/log';
import { deleteAccountFlow } from '../../../src/ui/deleteAccount';
import { errorText } from '../../../src/ui/logic';
import { confirm } from '../../../src/ui/native';
import {
  getNotificationsEnabled,
  pushAvailable,
  setNotificationsEnabled,
} from '../../../src/ui/pushAdapter';
import {
  accountView,
  accountsDetail,
  devicesSummary,
} from '../../../src/ui/settingsView';
import { setTheme, useThemeSetting } from '../../../src/ui/themeSetting';

export default function SettingsScreen() {
  const { auth, fleet } = useServices();
  const { session } = useAuthState();
  const orgs = useOrganizations();
  const accounts = useAccounts();
  const accountsSheet = useSheet('accounts');
  const [notify, setNotify] = useState(false);
  const [notifyError, setNotifyError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const theme = useThemeSetting((s) => s.theme);
  const devices = useFleetState((s) => s.devices);
  const me = useMemo(() => devices.find((d) => d.thisDevice), [devices]);
  const account = accountView(session, orgs);

  useEffect(() => {
    let live = true;
    getNotificationsEnabled(false).then((on) => live && setNotify(on));
    return () => {
      live = false;
    };
  }, []);

  const toggleNotify = (on: boolean) => {
    setNotify(on);
    setNotifyError(null);
    setNotificationsEnabled(fleet, on).catch((e: unknown) => {
      setNotify(!on);
      setNotifyError(errorText(e));
    });
  };

  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteAccount = async () => {
    setDeleteError(null);
    try {
      await deleteAccountFlow({
        confirm: async (o) => {
          const ok = await confirm(o);
          if (ok) setDeleting(true);
          return ok;
        },
        auth,
      });
    } catch (e: unknown) {
      log.warn('account deletion failed', {
        'error.code': 'account.delete_failed',
      });
      setDeleteError(errorText(e));
    } finally {
      setDeleting(false);
    }
  };

  const signOut = async () => {
    const ok = await confirm({
      title: 'Sign out of Theodore on this device?',
      message: 'Spaces keep running on your computers.',
      confirmLabel: 'Sign out',
      destructive: true,
    });
    if (!ok) return;
    setSigningOut(true);
    setSignOutError(null);
    auth
      .signOut()
      .catch((e: unknown) => setSignOutError(errorText(e)))
      .finally(() => setSigningOut(false));
  };

  return (
    <SettingsScroll testID="settings">
      <AccountCard account={account} />

      <SettingsRow
        icon="accounts"
        label="Accounts"
        detail={accountsDetail(accounts.length) || undefined}
        onPress={accountsSheet.open}
        testID="settings-accounts"
      />
      {accountsSheet.element}
      <SettingsRow
        icon="organization"
        label="Organization"
        detail={
          account.organization ?? (session?.organizationId ? undefined : '—')
        }
        href={'/settings/organization' as Href}
        testID="settings-organization"
      />
      <SettingsRow
        icon="devices"
        label="Devices"
        detail={devicesSummary(devices)}
        href={'/devices' as Href}
        testID="settings-devices"
      />
      <SettingsRow
        icon={kindSymbol(me?.kind ?? 'mobile')}
        label="This device"
        detail={me?.name || undefined}
        href={'/settings/device' as Href}
        testID="settings-this-device"
      />

      <SectionDivider />

      <SettingsMenuRow
        icon="appearance"
        label="Appearance"
        choices={THEME_CHOICES}
        value={theme}
        onChange={setTheme}
        testID="settings-theme"
      />
      <SettingsToggleRow
        icon="bell"
        label="Notifications"
        subtitle={
          pushAvailable()
            ? 'Questions and finished spaces, as they happen.'
            : 'Not available on this device.'
        }
        value={notify}
        disabled={!pushAvailable()}
        onValueChange={toggleNotify}
        testID="settings-notifications"
      />
      {notifyError ? <SectionNote danger>{notifyError}</SectionNote> : null}

      <SectionDivider />

      <PrivacyRows />

      <SectionDivider />

      <SettingsRow
        icon="info"
        label="About"
        detail={Constants.expoConfig?.version ?? undefined}
        href={'/settings/about' as Href}
        testID="settings-about"
      />

      <SectionDivider />

      <SettingsRow
        icon="sign-out"
        label="Sign out"
        destructive
        loading={signingOut}
        onPress={() => void signOut()}
        testID="settings-sign-out"
      />
      {signOutError ? <SectionNote danger>{signOutError}</SectionNote> : null}
      <SettingsRow
        icon="delete-account"
        label="Delete account"
        destructive
        loading={deleting}
        onPress={() => void deleteAccount()}
        testID="settings-delete-account"
      />
      {deleteError ? <SectionNote danger>{deleteError}</SectionNote> : null}
    </SettingsScroll>
  );
}
