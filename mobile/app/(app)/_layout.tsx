/**
 * The signed-in shell: the drawer (web: the sidebar) around a stack with
 * Home (`/`, a new space) at its root. Groups don't change URLs: `/`,
 * `/space/<id>`, `/devices`, `/settings` (its pages `/settings/organization`,
 * `/settings/device`, `/settings/about`, `/settings/collected`); `/start`
 * redirects to `/`.
 *
 * ```text
 * drawer ─ spaces by day, search, Devices, account / Settings
 *    │ pick
 *    ▼
 * Home ── push ─▶ devices | settings ── back ─▶ Home
 *                          └─ push ─▶ settings/organization | device | about
 *      ── Send / drawer ─▶ space/[id]: a fade, no edge swipe back, the main
 *                          header (☰, not Back); Android Back ─▶ Home
 * notification / deep link ─▶ space/[id] over Home (the anchor)
 * composer chip / where row (iOS) ─▶ model- | computer- | project-picker
 *                                   as a formSheet
 * space's activity strip (iOS) ─▶ activity-sheet as a formSheet
 * drawer's account row, Settings › Accounts (iOS) ─▶ accounts-sheet as a formSheet
 * a sub-space row ─▶ push sub-space/[space]/[child] (Back)
 * a file path in a reply, a file on your bubble ─▶ push file/[space]?path=… (Back)
 * long press a message › Select text (iOS) ─▶ select-text as a formSheet
 * ```
 *
 * Headers: Home's and a space's are `MainHeader` (menu, questions, new
 * space; iOS bar items, Android a Material 3 top app bar, web the JS
 * header). Pushed
 * screens use `PushedHeader` (a Material top app bar on Android), except
 * on iOS 26+, where every header is the native Liquid Glass bar over the
 * content (`src/shell/glassHeader.ts`).
 */
import { Stack, router, usePathname, type Href } from 'expo-router';
import { useEffect } from 'react';
import { AppShell } from '../../src/components/app-shell';
import { DrawerProvider } from '../../src/components/drawer-context';
import { handleNotificationResponses } from '../../src/push';
import { useServices } from '../../src/services';
import { setActiveSpace } from '../../src/shell/AppProviders';
import { glassHeader } from '../../src/shell/glassHeader';
import { screenOfPath, spaceIdFromPath } from '../../src/shell/paths';
import { PushedHeader } from '../../src/shell/PushedHeader';
import { track } from '../../src/telemetry/log';
import { liquidGlass } from '../../src/ui/native';
import { usePalette } from '../../src/ui/theme';
import { ToastHost } from '../../src/ui/Toast';

export const unstable_settings = { anchor: 'index' };

const web = process.env.EXPO_OS === 'web';

export default function AppLayout() {
  const p = usePalette();
  const services = useServices();
  const path = usePathname();

  useEffect(() => {
    setActiveSpace(spaceIdFromPath(path));
    // The screen's name only (`space`, `settings/about`), never an id.
    track('screen_viewed', { screen: screenOfPath(path) });
  }, [path]);

  useEffect(
    () =>
      handleNotificationResponses(services, (to) => router.push(to as Href)),
    [services],
  );

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

  // Home: MainHeader adds its buttons (Android: its whole app bar).
  const home = glassHeader
    ? {
        title: 'New space',
        headerTintColor: p.text,
        headerTitleStyle: { color: p.text },
        gestureEnabled: false,
      }
    : {
        title: 'New space',
        headerStyle: { backgroundColor: web ? p.surface : p.background },
        headerTintColor: p.text,
        headerTitleStyle: { color: p.text },
        headerShadowVisible: false,
        gestureEnabled: false,
      };

  // The picker sheets (iOS: the chips present them; Android and web open
  // theirs in place). iOS 26+: no background, the system's glass sheet.
  const sheet = (title: string) => ({
    title,
    presentation: 'formSheet' as const,
    sheetAllowedDetents: [0.5, 1],
    sheetGrabberVisible: true,
    headerShown: false,
    contentStyle: {
      backgroundColor: liquidGlass ? 'transparent' : p.surface,
    },
  });

  return (
    <DrawerProvider>
      <AppShell>
        <Stack
          screenOptions={{ contentStyle: { backgroundColor: p.background } }}
        >
          <Stack.Screen name="index" options={home} />
          <Stack.Screen
            name="space/[id]"
            options={{ ...home, title: 'Space', animation: 'fade' }}
          />
          <Stack.Screen
            name="sub-space/[space]/[child]"
            options={pushed('Sub-space')}
          />
          <Stack.Screen name="file/[space]" options={pushed('File')} />
          <Stack.Screen name="devices" options={pushed('Devices')} />
          <Stack.Screen name="settings/index" options={pushed('Settings')} />
          <Stack.Screen
            name="settings/organization"
            options={pushed('Organization')}
          />
          <Stack.Screen
            name="settings/device"
            options={pushed('This device')}
          />
          <Stack.Screen name="settings/about" options={pushed('About')} />
          <Stack.Screen
            name="settings/collected"
            options={pushed("What's collected")}
          />
          <Stack.Screen name="start" options={{ headerShown: false }} />
          <Stack.Screen name="model-picker" options={sheet('Model')} />
          <Stack.Screen name="computer-picker" options={sheet('Computer')} />
          <Stack.Screen name="project-picker" options={sheet('Project')} />
          <Stack.Screen name="activity-sheet" options={sheet('Activity')} />
          <Stack.Screen name="accounts-sheet" options={sheet('Accounts')} />
          <Stack.Screen name="select-text" options={sheet('Select text')} />
        </Stack>
      </AppShell>
      {/* Over the shell, the open drawer included (an archive from a row). */}
      <ToastHost />
    </DrawerProvider>
  );
}
