/**
 * `/callback`: where AuthKit sends the browser back.
 *
 * - web: this page is the sign-in popup; the root layout already handed
 *   its URL to the opener (`maybeCompleteAuthSession`), which closes it.
 * - Android: the `theodore-mobile://callback` intent may also reach the router
 *   while the browser session resolves; step back to the sign-in, which
 *   finishes the exchange.
 * - signed in: the gate never shows this route.
 */
import { router, type Href } from 'expo-router';
import { useEffect } from 'react';
import { Platform, Text, View } from 'react-native';
import { Progress } from '../../src/ui/native';
import { usePalette } from '../../src/ui/theme';

export default function Callback() {
  const p = usePalette();
  useEffect(() => {
    if (
      Platform.OS === 'web' &&
      typeof window !== 'undefined' &&
      window.opener
    ) {
      return; // the opener closes this popup
    }
    if (router.canGoBack()) router.back();
    else router.replace('/sign-in' as Href);
  }, []);
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        backgroundColor: p.background,
      }}
    >
      <Progress accessibilityLabel="Finishing sign-in" />
      <Text style={{ color: p.muted, fontSize: 15 }}>Finishing sign-in…</Text>
    </View>
  );
}
