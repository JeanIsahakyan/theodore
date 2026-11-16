// Adapted from EvanBacon/chat-template (MIT)
/**
 * Settings, the template's flat page: an account card, then icon rows;
 * a row with "›" opens its page (docs/mobile.md "Settings and Devices").
 *
 * ```text
 * (JI) Jean · jean@example.com · Acme · Admin
 * Organization   Acme        › ─▶ settings/organization (switch)
 * Devices        2 online    › ─▶ devices
 * This device    Jean's iPhone › ─▶ settings/device (fingerprint, copy)
 * ──────────
 * Appearance     System ⌃⌄     native menu ─▶ applied app-wide, kept
 * Notifications  (  ●)         haptic tick
 * ──────────
 * About          1.0.0       › ─▶ settings/about (version, server)
 * ──────────
 * ⇥ Sign out (red)  ─▶ system confirm ─▶ signed out
 * ```
 */
import Constants from 'expo-constants';
import { useEffect, useMemo, useState } from 'react';
import type { Href } from 'expo-router';
import {
  AccountCard,
  SectionDivider,
  SectionNote,
  SettingsMenuRow,
  SettingsRow,
  SettingsScroll,
  SettingsToggleRow,
  kindSymbol,
  useOrganizations,
} from '../../../src/components/settings';
import { useServices } from '../../../src/services';
import { useAuthState } from '../../../src/shell/AppProviders';
import { useFleetState } from '../../../src/state/fleet';
import { THEME_CHOICES } from '../../../src/ui/appearance';
import { errorText } from '../../../src/ui/logic';
import { confirm } from '../../../src/ui/native';
import {
  getNotificationsEnabled,
  pushAvailable,
  setNotificationsEnabled,
} from '../../../src/ui/pushAdapter';
import { accountView, devicesSummary } from '../../../src/ui/settingsView';
import { setTheme, useThemeSetting } from '../../../src/ui/themeSetting';

export default function SettingsScreen() {
  const { auth, fleet } = useServices();
  const { session } = useAuthState();
  const orgs = useOrganizations();
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
    </SettingsScroll>
  );
}
