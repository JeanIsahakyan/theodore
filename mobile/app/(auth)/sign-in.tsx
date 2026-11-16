/**
 * Sign in: one button to the hosted AuthKit page (email code, Google, SSO,
 * passkeys: whatever the WorkOS environment enables). Several organizations
 * ─▶ the picker; signed in ─▶ the gate moves on by itself.
 */
import { router, type Href } from 'expo-router';
import { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useServices } from '../../src/services';
import { useAuthState } from '../../src/shell/AppProviders';
import { Button, Notice } from '../../src/ui/kit';
import { usePalette } from '../../src/ui/theme';

export default function SignIn() {
  const { auth } = useServices();
  const { setChoices } = useAuthState();
  const p = usePalette();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Not async before signIn(): on the web the popup must open in the
  // press's own task.
  const signIn = () => {
    setError(null);
    setBusy(true);
    auth
      .signIn()
      .then((r) => {
        switch (r.kind) {
          case 'choose_organization':
            setChoices(r.organizations);
            router.push('/choose-organization' as Href);
            break;
          case 'failed':
            setError(r.message);
            break;
          default:
            break;
        }
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: p.background }]}>
      <View style={styles.body}>
        <Image
          source={require('../../assets/logo.png')}
          style={styles.logo}
          accessibilityIgnoresInvertColors
          accessible={false}
        />
        <Text
          accessibilityRole="header"
          style={[styles.title, { color: p.text }]}
        >
          Theodore
        </Text>
        <Text style={[styles.lead, { color: p.muted }]}>
          Start, follow and answer the spaces running on your computers.
        </Text>
        <View style={styles.actions}>
          <Button
            kind="primary"
            label="Sign in"
            accessibilityLabel="Sign in with your Theodore account"
            busy={busy}
            onPress={signIn}
          />
          <Text style={[styles.hint, { color: p.muted }]}>
            You continue in a secure browser window and come back here.
          </Text>
          {error ? <Notice tone="danger">{error}</Notice> : null}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: {
    flex: 1,
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 12,
  },
  logo: { width: 72, height: 72, borderRadius: 16, alignSelf: 'center' },
  title: { fontSize: 32, fontWeight: '700', textAlign: 'center' },
  lead: { fontSize: 16, lineHeight: 22, textAlign: 'center' },
  actions: { marginTop: 24, gap: 12 },
  hint: { fontSize: 13, textAlign: 'center' },
});
