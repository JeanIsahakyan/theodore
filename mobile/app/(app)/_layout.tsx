/**
 * The signed-in shell: Spaces, Devices and Settings tabs; `space/[id]` and
 * `start` open over them (no tab bar, a back button). Waiting questions sit
 * under the header of every tab.
 *
 * ```text
 * Spaces ── push ─▶ space/[id] ── back ─▶ Spaces
 *        └─ push ─▶ start ── replace ─▶ space/[id]
 * ```
 *
 * The routes are flat files beside this layout (the screens own them), so
 * the pushed routes are tabs without a button, and `backBehavior:
 * "history"` gives back its stack meaning. Not `href: null`: since SDK 58
 * that hides the screen itself (focusing it bounces to the first tab).
 */
import { Tabs, type BottomTabHeaderProps } from 'expo-router/js-tabs';
import { Header, getHeaderTitle } from 'expo-router/react-navigation';
import { router, usePathname, type Href } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';
import { handleNotificationResponses } from '../../src/push';
import { useServices } from '../../src/services';
import { setActiveSpace } from '../../src/shell/AppProviders';
import { spaceIdFromPath } from '../../src/shell/paths';
import {
  DevicesIcon,
  SettingsIcon,
  SpacesIcon,
} from '../../src/shell/TabIcons';
import { QuestionsBanner } from '../../src/ui/QuestionsBanner';
import { usePalette } from '../../src/ui/theme';

export const unstable_settings = { anchor: 'index' };

type TabHeaderProps = Pick<BottomTabHeaderProps, 'options' | 'route'>;

function BackButton({ color }: { color: string }) {
  const back = () =>
    router.canGoBack() ? router.back() : router.replace('/' as Href);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Back"
      hitSlop={12}
      onPress={back}
      style={{ paddingHorizontal: 16, paddingVertical: 8 }}
    >
      <Text style={{ color, fontSize: 17 }}>‹ Back</Text>
    </Pressable>
  );
}

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

  const pushed = {
    tabBarButton: () => null,
    tabBarItemStyle: { display: 'none' as const },
    tabBarStyle: { display: 'none' as const },
    headerLeft: () => <BackButton color={p.accent} />,
    // Their own question card is on the page: no banner here.
    header: ({ options, route }: TabHeaderProps) => (
      <Header {...options} title={getHeaderTitle(options, route.name)} />
    ),
  };

  return (
    <Tabs
      backBehavior="history"
      screenOptions={{
        headerStyle: { backgroundColor: p.surface },
        headerTintColor: p.text,
        headerTitleStyle: { color: p.text },
        tabBarActiveTintColor: p.accent,
        tabBarInactiveTintColor: p.muted,
        tabBarStyle: { backgroundColor: p.surface, borderTopColor: p.border },
        sceneStyle: { backgroundColor: p.background },
        header: ({ options, route }) => (
          <View>
            <Header {...options} title={getHeaderTitle(options, route.name)} />
            <QuestionsBanner />
          </View>
        ),
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Spaces',
          tabBarIcon: ({ color, size }) => (
            <SpacesIcon color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="devices"
        options={{
          title: 'Devices',
          tabBarIcon: ({ color, size }) => (
            <DevicesIcon color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size }) => (
            <SettingsIcon color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="space/[id]"
        options={{
          ...pushed,
          title: 'Space',
        }}
      />
      <Tabs.Screen
        name="start"
        options={{ ...pushed, title: 'Start a space' }}
      />
    </Tabs>
  );
}
