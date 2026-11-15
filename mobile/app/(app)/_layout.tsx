/**
 * The signed-in shell: a stack with the tabs at its root, and `space/[id]`
 * and `start` pushed over them (no tab bar, a "‹ Back" header). Groups
 * don't change URLs: `/`, `/devices`, `/settings`, `/space/<id>`, `/start`.
 *
 * ```text
 * (tabs): Spaces · Devices · Settings
 *   Spaces ── push ─▶ space/[id] ── back ─▶ Spaces
 *          └─ push ─▶ start ── replace ─▶ space/[id]
 * notification / deep link ─▶ space/[id] over (tabs) (the anchor)
 * ```
 */
import { Stack, router, usePathname, type Href } from 'expo-router';
import { useEffect } from 'react';
import { handleNotificationResponses } from '../../src/push';
import { useServices } from '../../src/services';
import { setActiveSpace } from '../../src/shell/AppProviders';
import { spaceIdFromPath } from '../../src/shell/paths';
import { PushedHeader } from '../../src/shell/PushedHeader';
import { usePalette } from '../../src/ui/theme';

export const unstable_settings = { anchor: '(tabs)' };

export default function AppLayout() {
  const p = usePalette();
  const { fleet } = useServices();
  const path = usePathname();

  useEffect(() => {
    setActiveSpace(spaceIdFromPath(path));
  }, [path]);

  useEffect(
    () => handleNotificationResponses(fleet, (to) => router.push(to as Href)),
    [fleet],
  );

  return (
    <Stack
      screenOptions={{
        contentStyle: { backgroundColor: p.background },
        // Their own question card is on the page: no banner here.
        header: ({ options }) => (
          <PushedHeader
            title={typeof options.title === 'string' ? options.title : ''}
          />
        ),
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="space/[id]" options={{ title: 'Space' }} />
      <Stack.Screen name="start" options={{ title: 'Start a space' }} />
    </Stack>
  );
}
