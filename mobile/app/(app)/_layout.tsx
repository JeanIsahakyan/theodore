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
 *
 * Headers: on iOS and Android the tabs are native and draw none, so this
 * stack's native header shows the focused tab's title; the web's JS tabs
 * draw their own. Pushed screens use `PushedHeader` (a Material top app bar
 * on Android), except on iOS 26+, where every header is the native Liquid
 * Glass bar over the content (`src/shell/glassHeader.ts`).
 */
import { Stack, router, usePathname, type Href } from 'expo-router';
import { getFocusedRouteNameFromRoute } from 'expo-router/react-navigation';
import { useEffect } from 'react';
import { handleNotificationResponses } from '../../src/push';
import { useServices } from '../../src/services';
import { setActiveSpace } from '../../src/shell/AppProviders';
import { spaceIdFromPath } from '../../src/shell/paths';
import { glassHeader } from '../../src/shell/glassHeader';
import { PushedHeader } from '../../src/shell/PushedHeader';
import { tabTitle } from '../../src/shell/tabs';
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

  // Their own question card is on the page: no banner here.
  const pushed = (title: string) =>
    glassHeader
      ? {
          // No background set: the system's glass bar, over the content.
          title,
          headerBackButtonDisplayMode: 'minimal' as const,
          headerTintColor: p.accent,
          // Else a transparent bar draws the title in the tint.
          headerTitleStyle: { color: p.text },
        }
      : {
          title,
          header: ({ options }: { options: { title?: string } }) => (
            <PushedHeader
              title={typeof options.title === 'string' ? options.title : title}
            />
          ),
        };

  return (
    <Stack screenOptions={{ contentStyle: { backgroundColor: p.background } }}>
      <Stack.Screen
        name="(tabs)"
        options={({ route }) =>
          process.env.EXPO_OS === 'web'
            ? { headerShown: false }
            : glassHeader
              ? {
                  // No background: the glass bar, content scrolls under it.
                  title: tabTitle(getFocusedRouteNameFromRoute(route)),
                  headerTintColor: p.accent,
                  headerTitleStyle: { color: p.text },
                }
              : {
                  title: tabTitle(getFocusedRouteNameFromRoute(route)),
                  headerStyle: { backgroundColor: p.background },
                  headerTintColor: p.accent,
                  headerTitleStyle: { color: p.text },
                  headerShadowVisible: false,
                }
        }
      />
      <Stack.Screen name="space/[id]" options={pushed('Space')} />
      <Stack.Screen name="start" options={pushed('Start a space')} />
    </Stack>
  );
}
