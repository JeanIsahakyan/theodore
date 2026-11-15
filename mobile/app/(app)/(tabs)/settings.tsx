/**
 * Settings: account, organization (current + switch), notifications, sign out.
 * A failed organization switch is said inline and never signs you out.
 */
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import type { Organization, Session } from '../../../src/auth/types';
import { useServices } from '../../../src/services';
import {
  Button,
  Card,
  Chip,
  Confirm,
  Notice,
  SectionTitle,
} from '../../../src/ui/kit';
import { errorText, roleLabel, switchErrorText } from '../../../src/ui/logic';
import {
  getNotificationsEnabled,
  pushAvailable,
  setNotificationsEnabled,
} from '../../../src/ui/pushAdapter';
import { usePalette } from '../../../src/ui/theme';

function Row({ label, value }: { label: string; value: string }) {
  const p = usePalette();
  return (
    <View style={styles.row}>
      <Text style={[styles.label, { color: p.muted }]}>{label}</Text>
      <Text selectable style={[styles.value, { color: p.text }]}>
        {value}
      </Text>
    </View>
  );
}

export default function SettingsScreen() {
  const { auth, fleet } = useServices();
  const p = usePalette();
  const [session, setSession] = useState<Session | null>(null);
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [switching, setSwitching] = useState<string | null>(null);
  const [orgError, setOrgError] = useState<string | null>(null);
  const [notify, setNotify] = useState(false);
  const [notifyError, setNotifyError] = useState<string | null>(null);
  const [signOutAsk, setSignOutAsk] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

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
        // the account row stays empty; the shell handles a lost session
      });
    getNotificationsEnabled(false).then((on) => live && setNotify(on));
    return () => {
      live = false;
    };
  }, [auth]);

  const current = orgs.find((o) => o.id === session?.organizationId);

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

  const signOut = () => {
    setSigningOut(true);
    setSignOutError(null);
    auth
      .signOut()
      .catch((e: unknown) => setSignOutError(errorText(e)))
      .finally(() => {
        setSigningOut(false);
        setSignOutAsk(false);
      });
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
    >
      <SectionTitle>Account</SectionTitle>
      <Card>
        <Row label="Email" value={session?.email ?? '—'} />
        {session?.name ? <Row label="Name" value={session.name} /> : null}
      </Card>

      <SectionTitle>Organization</SectionTitle>
      <Card>
        <Text selectable style={[styles.value, { color: p.text }]}>
          {current?.name ?? (session?.organizationId ? 'Organization' : '—')}
        </Text>
        {(current?.role ?? session?.role) ? (
          <Text style={[styles.label, { color: p.muted }]}>
            {roleLabel((current?.role ?? session?.role) as string)}
          </Text>
        ) : null}
        {orgs.length > 1 ? (
          <View style={styles.choices}>
            {orgs.map((o) => (
              <Chip
                key={o.id}
                label={switching === o.id ? `${o.name}…` : o.name}
                accessibilityLabel={`Switch to ${o.name}`}
                selected={o.id === session?.organizationId}
                disabled={switching !== null}
                onPress={() => switchTo(o.id)}
              />
            ))}
          </View>
        ) : null}
        {orgError ? <Notice tone="danger">{orgError}</Notice> : null}
      </Card>

      <SectionTitle>Notifications</SectionTitle>
      <Card>
        <View style={styles.switchRow}>
          <View style={styles.flex}>
            <Text style={[styles.value, { color: p.text }]}>Notifications</Text>
            <Text style={[styles.label, { color: p.muted }]}>
              {pushAvailable()
                ? 'Questions and finished spaces, as they happen.'
                : 'Not available on this device.'}
            </Text>
          </View>
          <Switch
            accessibilityLabel="Notifications"
            value={notify}
            disabled={!pushAvailable()}
            onValueChange={toggleNotify}
          />
        </View>
        {notifyError ? <Notice tone="danger">{notifyError}</Notice> : null}
      </Card>

      {signOutAsk ? (
        <Confirm
          title="Sign out of Theodore on this device?"
          confirmLabel="Sign out"
          danger
          busy={signingOut}
          onConfirm={signOut}
          onCancel={() => setSignOutAsk(false)}
        />
      ) : (
        <Button
          label="Sign out"
          kind="danger"
          onPress={() => setSignOutAsk(true)}
        />
      )}
      {signOutError ? <Notice tone="danger">{signOutError}</Notice> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12 },
  flex: { flex: 1 },
  row: { gap: 2 },
  label: { fontSize: 13 },
  value: { fontSize: 17 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
});
