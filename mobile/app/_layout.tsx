/**
 * Root navigator and the auth gate (docs/mobile.md "App").
 *
 * ```text
 * loading     ─▶ splash
 * signed out  ─▶ (auth): sign-in, choose-organization, callback
 * signed in   ─▶ (app): the drawer around Home (new space), space/[id],
 *                devices, settings
 * ```
 *
 * Around everything: gestures (the drawer), the keyboard controller (the
 * composer rides on the keyboard), Uniwind's tokens (src/global.css; on
 * Android 12+ Material You's, `applyThemeVars`) and its safe-area insets.
 * The Theme setting (Light / Dark / System) is applied before anything
 * draws (`initTheme`).
 *
 * A guard flipping (sign-in, sign-out, a session that ended) moves the
 * user to the other group; deep links into a guarded group land on its
 * anchor.
 */
import '../src/global.css';
import { Stack, type Href } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import * as WebBrowser from 'expo-web-browser';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaListener } from 'react-native-safe-area-context';
import { Uniwind } from 'uniwind';
import { applyThemeVars } from '../src/components/theme-vars';
import { AppProviders, useAuthState } from '../src/shell/AppProviders';
import { usePalette, useScheme } from '../src/ui/theme';
import { initTheme } from '../src/ui/themeSetting';

applyThemeVars();
initTheme();

// Web: this page may be the sign-in popup coming back on `/callback`; hand
// the URL to the window that opened it (a no-op anywhere else).
WebBrowser.maybeCompleteAuthSession();

function Gate() {
  const { status } = useAuthState();
  const p = usePalette();
  // The window behind the screens (keyboard and drawer edges, rotation).
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(p.background).catch(() => {});
  }, [p.background]);
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

/** Status bar content for the app's scheme (the Theme setting), not the system's. */
function SchemeStatusBar() {
  return <StatusBar style={useScheme() === 'dark' ? 'light' : 'dark'} />;
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaListener onChange={({ insets }) => Uniwind.updateInsets(insets)}>
        <KeyboardProvider>
          <AppProviders>
            <SchemeStatusBar />
            <Gate />
          </AppProviders>
        </KeyboardProvider>
      </SafeAreaListener>
    </GestureHandlerRootView>
  );
}
