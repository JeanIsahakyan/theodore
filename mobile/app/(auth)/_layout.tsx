/** Signed out: the sign-in, the organization picker, the redirect page. */
import { Stack } from 'expo-router';
import { usePalette } from '../../src/ui/theme';

export const unstable_settings = { anchor: 'sign-in' };

export default function AuthLayout() {
  const p = usePalette();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: p.background },
      }}
    >
      <Stack.Screen name="sign-in" />
      <Stack.Screen
        name="choose-organization"
        options={{
          headerShown: true,
          title: 'Organization',
          headerBackTitle: 'Back',
          headerStyle: { backgroundColor: p.background },
          headerTintColor: p.accent,
          headerTitleStyle: { color: p.text },
          headerShadowVisible: false,
        }}
      />
      <Stack.Screen name="callback" options={{ animation: 'none' }} />
    </Stack>
  );
}
