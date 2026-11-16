/**
 * Settings, the native kit's reference screen (docs/mobile.md "Native UI"):
 * one grouped `Form`, like iOS Settings / a Material list.
 *
 * ```text
 * Account        Email, Name
 * Organization   one row per org (checkmark on the current; tap to switch)
 * This device    Name, Status, Fingerprint (to compare on the computer)
 * Notifications  switch
 *                Sign out ─▶ system confirm ─▶ signed out
 * About          Version, Server
 * ```
 *
 * A failed organization switch is said under its section and never signs
 * you out.
 */
import Constants from 'expo-constants';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Organization, Session } from '../../src/auth/types';
import { config } from '../../src/config';
import { useServices } from '../../src/services';
import { useFleetState } from '../../src/state/fleet';
import { Fingerprint } from '../../src/ui/kit';
import { errorText, roleLabel, switchErrorText } from '../../src/ui/logic';
import {
  Button,
  Form,
  FormSlot,
  Row,
  Section,
  Switch,
  confirm,
} from '../../src/ui/native';
import {
  getNotificationsEnabled,
  pushAvailable,
  setNotificationsEnabled,
} from '../../src/ui/pushAdapter';
import { usePalette } from '../../src/ui/theme';

const STATUS = {
  off: 'Off',
  connecting: 'Connecting…',
  connected: 'Connected',
  error: 'Not connected',
} as const;

const host = (url: string) => url.replace(/^\w+:\/\//, '').replace(/\/.*$/, '');

export default function SettingsScreen() {
  const { auth, fleet } = useServices();
  const p = usePalette();
  const [session, setSession] = useState<Session | null>(null);
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [switching, setSwitching] = useState<string | null>(null);
  const [orgError, setOrgError] = useState<string | null>(null);
  const [notify, setNotify] = useState(false);
  const [notifyError, setNotifyError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
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
      <Section title="Account">
        <Row label="Email" value={session?.email ?? '—'} />
        {session?.name ? <Row label="Name" value={session.name} /> : null}
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
        <Row label="Name" value={me?.name || '—'} />
        <Row label="Status" value={STATUS[connection]} />
        <FormSlot>
          <View style={styles.slot}>
            <Text style={[styles.slotLabel, { color: p.muted }]}>
              Fingerprint
            </Text>
            <Fingerprint value={fingerprint} />
          </View>
        </FormSlot>
      </Section>

      <Section title="Notifications" footer={notifyError ?? undefined}>
        <Switch
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

      <Section footer={signOutError ?? undefined}>
        <Button
          label="Sign out"
          variant="destructive"
          loading={signingOut}
          onPress={() => void signOut()}
        />
      </Section>

      <Section title="About">
        <Row label="Version" value={Constants.expoConfig?.version ?? '—'} />
        <Row label="Server" value={host(config.cloudUrl)} />
      </Section>
    </Form>
  );
}

const styles = StyleSheet.create({
  slot: { gap: 6 },
  slotLabel: { fontSize: 13 },
});
