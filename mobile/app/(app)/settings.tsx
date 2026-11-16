// Adapted from EvanBacon/chat-template (MIT)
/**
 * Settings, the native kit's reference screen (docs/mobile.md "Native UI"):
 * one grouped `Form`, like iOS Settings / a Material 3 settings list, each
 * row led by its icon (SF Symbol / Material Symbol / Lucide).
 *
 * ```text
 * Appearance     Theme  Light | Dark | System ─▶ applied app-wide, kept
 * Account        Email, Name
 * Organization   one row per org (checkmark on the current; tap to switch)
 * This device    Name, Status, Fingerprint (monospace; compare on the computer)
 * Notifications  switch
 * About          Version, Server
 * ━━ Sign out ━━ red, full width ─▶ system confirm ─▶ signed out
 * ```
 *
 * A failed organization switch is said under its section and never signs
 * you out.
 */
import Constants from 'expo-constants';
import { useEffect, useState } from 'react';
import type { Organization, Session } from '../../src/auth/types';
import { config } from '../../src/config';
import { useServices } from '../../src/services';
import { useFleetState } from '../../src/state/fleet';
import { THEME_CHOICES } from '../../src/ui/appearance';
import { FingerprintItem } from '../../src/ui/DeviceItem';
import { CONNECTION_LABEL } from '../../src/ui/deviceView';
import { errorText, roleLabel, switchErrorText } from '../../src/ui/logic';
import {
  Button,
  Form,
  Row,
  Section,
  Select,
  Switch,
  confirm,
} from '../../src/ui/native';
import { kindIcon } from '../../src/ui/native/icons';
import {
  getNotificationsEnabled,
  pushAvailable,
  setNotificationsEnabled,
} from '../../src/ui/pushAdapter';
import { setTheme, useThemeSetting } from '../../src/ui/themeSetting';

const host = (url: string) => url.replace(/^\w+:\/\//, '').replace(/\/.*$/, '');

export default function SettingsScreen() {
  const { auth, fleet } = useServices();
  const [session, setSession] = useState<Session | null>(null);
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [switching, setSwitching] = useState<string | null>(null);
  const [orgError, setOrgError] = useState<string | null>(null);
  const [notify, setNotify] = useState(false);
  const [notifyError, setNotifyError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const theme = useThemeSetting((s) => s.theme);
  const connection = useFleetState((s) => s.connection);
  const fingerprint = useFleetState((s) => s.fingerprint);
  const me = useFleetState((s) => s.devices.find((d) => d.thisDevice));

  useEffect(() => {
    let live = true;
    Promise.all([
      auth.current(),
      auth.organizations().catch(() => [] as Organization[]),
    ])
      .then(([s, o]) => {
        if (!live) return;
        setSession(s);
        setOrgs(o);
      })
      .catch(() => {
        // the account rows stay empty; the shell handles a lost session
      });
    getNotificationsEnabled(false).then((on) => live && setNotify(on));
    return () => {
      live = false;
    };
  }, [auth]);

  const current = orgs.find((o) => o.id === session?.organizationId);
  const role = current?.role ?? session?.role ?? null;

  const switchTo = (id: string) => {
    if (switching || id === session?.organizationId) return;
    setSwitching(id);
    setOrgError(null);
    auth
      .switchOrganization(id)
      .then((s) => setSession(s))
      .catch((e: unknown) => setOrgError(switchErrorText(errorText(e))))
      .finally(() => setSwitching(null));
  };

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
    <Form testID="settings">
      <Section title="Appearance">
        <Select
          label="Theme"
          icon="theme"
          choices={THEME_CHOICES}
          value={theme}
          onChange={setTheme}
          testID="settings-theme"
        />
      </Section>

      <Section title="Account">
        <Row icon="email" label="Email" value={session?.email ?? '—'} />
        {session?.name ? (
          <Row icon="person" label="Name" value={session.name} />
        ) : null}
      </Section>

      <Section
        title="Organization"
        footer={
          orgError ??
          (orgs.length > 1
            ? 'Spaces and devices belong to the organization you are in.'
            : undefined)
        }
      >
        {orgs.length > 1 ? (
          orgs.map((o) => (
            <Row
              key={o.id}
              icon="organization"
              label={o.name}
              detail={
                o.id === session?.organizationId && role
                  ? roleLabel(role)
                  : undefined
              }
              selected={o.id === session?.organizationId}
              loading={switching === o.id}
              disabled={switching !== null && switching !== o.id}
              accessibilityLabel={`Switch to ${o.name}`}
              onPress={() => switchTo(o.id)}
            />
          ))
        ) : (
          <Row
            icon="organization"
            label={
              current?.name ?? (session?.organizationId ? 'Organization' : '—')
            }
            value={role ? roleLabel(role) : undefined}
          />
        )}
      </Section>

      <Section
        title="This device"
        footer="Compare the fingerprint with the one your computer shows before you trust this device there."
      >
        <Row
          icon={kindIcon(me?.kind ?? 'mobile')}
          label="Name"
          value={me?.name || '—'}
        />
        <Row
          icon="status"
          label="Status"
          value={CONNECTION_LABEL[connection]}
        />
        <FingerprintItem label="Fingerprint" value={fingerprint} />
      </Section>

      <Section title="Notifications" footer={notifyError ?? undefined}>
        <Switch
          icon="notifications"
          label="Notifications"
          detail={
            pushAvailable()
              ? 'Questions and finished spaces, as they happen.'
              : 'Not available on this device.'
          }
          value={notify}
          disabled={!pushAvailable()}
          onValueChange={toggleNotify}
        />
      </Section>

      <Section title="About">
        <Row
          icon="info"
          label="Version"
          value={Constants.expoConfig?.version ?? '—'}
        />
        <Row icon="server" label="Server" value={host(config.cloudUrl)} />
      </Section>

      <Section plain footer={signOutError ?? undefined}>
        <Button
          label="Sign out"
          variant="destructive"
          fullWidth
          loading={signingOut}
          onPress={() => void signOut()}
          testID="settings-sign-out"
        />
      </Section>
    </Form>
  );
}
