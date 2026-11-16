/**
 * Sign in: one button to the hosted AuthKit page (email code, Google, SSO,
 * passkeys: whatever the WorkOS environment enables). Several organizations
 * ─▶ the picker; signed in ─▶ the gate moves on by itself.
 *
 * ```text
 * ┌──────────────────────────────┐
 * │            [logo]            │   a welcome screen: logo, name, one line,
 * │           Theodore           │   centered in the space above the action
 * │   Start, follow and answer…  │
 * │                              │
 * │  [         Sign in        ]  │   native prominent button, full width,
 * │  You continue in a secure…   │   pinned to the bottom (safe area)
 * └──────────────────────────────┘
 * ```
 */
import { router, type Href } from 'expo-router';
import { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useServices } from '../../src/services';
import { useAuthState } from '../../src/shell/AppProviders';
import { Notice } from '../../src/ui/kit';
import { Button } from '../../src/ui/native';
import { usePalette } from '../../src/ui/theme';

const android = process.env.EXPO_OS === 'android';

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
      <View style={styles.column}>
        <View style={styles.hero}>
          <Image
            source={require('../../assets/logo.png')}
            style={styles.logo}
            accessibilityIgnoresInvertColors
            accessible={false}
          />
          <Text
            accessibilityRole="header"
            style={[
              android ? styles.titleAndroid : styles.titleIos,
              { color: p.text },
            ]}
          >
            Theodore
          </Text>
          <Text style={[styles.lead, { color: p.muted }]}>
            Start, follow and answer the spaces running on your computers.
          </Text>
        </View>
        <View style={styles.actions}>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <Button
            variant="primary"
            label="Sign in"
            accessibilityLabel="Sign in with your Theodore account"
            loading={busy}
            fullWidth
            onPress={signIn}
          />
          <Text style={[styles.hint, { color: p.muted }]}>
            You continue in a secure browser window and come back here.
          </Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  column: {
    flex: 1,
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
    paddingHorizontal: 24,
    paddingBottom: 16,
  },
  hero: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  // The art carries its own rounded tile and margin.
  logo: { width: 120, height: 120 },
  titleIos: {
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: 0.4,
    textAlign: 'center',
  },
  titleAndroid: { fontSize: 32, fontWeight: '400', textAlign: 'center' },
  lead: { fontSize: 17, lineHeight: 23, textAlign: 'center', maxWidth: 320 },
  actions: { gap: 12, alignItems: 'stretch' },
  hint: { fontSize: 13, lineHeight: 18, textAlign: 'center' },
});
