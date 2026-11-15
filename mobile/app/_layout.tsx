/**
 * Root navigator and the auth gate (docs/mobile.md "App").
 *
 * ```text
 * loading     ─▶ splash
 * signed out  ─▶ (auth): sign-in, choose-organization, callback
 * signed in   ─▶ (app): Spaces · Devices · Settings tabs, space/[id], start
 * ```
 *
 * A guard flipping (sign-in, sign-out, a session that ended) moves the
 * user to the other group; deep links into a guarded group land on its
 * anchor.
 */
import { Stack, type Href } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as WebBrowser from 'expo-web-browser';
import { ActivityIndicator, View } from 'react-native';
import { AppProviders, useAuthState } from '../src/shell/AppProviders';
import { usePalette } from '../src/ui/theme';

// Web: this page may be the sign-in popup coming back on `/callback`; hand
// the URL to the window that opened it (a no-op anywhere else).
WebBrowser.maybeCompleteAuthSession();

function Gate() {
  const { status } = useAuthState();
  const p = usePalette();
  if (status === 'loading') {
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: p.background,
        }}
      >
        <ActivityIndicator accessibilityLabel="Loading" color={p.muted} />
      </View>
    );
  }
  const signedIn = status === 'signed_in';
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: p.background },
      }}
    >
      {/* Explicit targets: the root's first unguarded child would otherwise
          be a generated route (+not-found). */}
      <Stack.Protected guard={signedIn} redirectTo={'/sign-in' as Href}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
      <Stack.Protected guard={!signedIn} redirectTo={'/' as Href}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <AppProviders>
      <StatusBar style="auto" />
      <Gate />
    </AppProviders>
  );
}
