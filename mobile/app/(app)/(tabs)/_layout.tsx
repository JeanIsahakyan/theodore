/**
 * The three tabs: Spaces, Devices, Settings. Screens without a tab (a
 * space, Start a space) live in the stack around this navigator
 * (`../_layout.tsx`), so a screen reader counts three tabs. Back from
 * Devices or Settings goes to Spaces.
 *
 * ```text
 * iOS, Android  native tabs (UITabBarController / Material 3 navigation bar),
 *               SF Symbols / Material Symbols; the title is the stack's
 *               native header (../_layout.tsx); waiting questions sit between
 *               the header and the tab. iOS 26+: the header and the tab bar
 *               are Liquid Glass over the content (nothing opaque behind
 *               them); the banner starts below the header
 * web           JS tabs, a header per tab with the waiting questions under it
 * ```
 */
import { Tabs } from 'expo-router/js-tabs';
import { NativeTabs } from 'expo-router/native-tabs';
import { Header, getHeaderTitle } from 'expo-router/react-navigation';
import { View } from 'react-native';
import {
  UnderGlassHeader,
  useGlassHeaderInset,
} from '../../../src/shell/glassHeader';
import { useFleetState } from '../../../src/state/fleet';
import { TAB_TITLES } from '../../../src/shell/tabs';
import {
  DevicesIcon,
  SettingsIcon,
  SpacesIcon,
} from '../../../src/shell/TabIcons';
import { QuestionsBanner } from '../../../src/ui/QuestionsBanner';
import { usePalette } from '../../../src/ui/theme';

export const unstable_settings = { anchor: 'index' };

function NativeTabsLayout() {
  const p = usePalette();
  const top = useGlassHeaderInset();
  // The banner, when shown, takes the room under the header.
  const banner = useFleetState((s) => s.questions.length > 0);
  return (
    <View style={{ flex: 1, backgroundColor: p.background }}>
      <QuestionsBanner top={top} glass />
      <UnderGlassHeader.Provider value={!banner}>
        <NativeTabs
          backBehavior="initialRoute"
          tintColor={p.accent}
          indicatorColor={p.surfaceMuted}
          labelVisibilityMode="labeled"
        >
          <NativeTabs.Trigger name="index">
            <NativeTabs.Trigger.Label>Spaces</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon
              sf={{
                default: 'list.bullet.rectangle',
                selected: 'list.bullet.rectangle.fill',
              }}
              md="view_list"
            />
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name="devices">
            <NativeTabs.Trigger.Label>Devices</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon
              sf="laptopcomputer.and.iphone"
              md="devices"
            />
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name="settings">
            <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon
              sf={{ default: 'gearshape', selected: 'gearshape.fill' }}
              md="settings"
            />
          </NativeTabs.Trigger>
        </NativeTabs>
      </UnderGlassHeader.Provider>
    </View>
  );
}

function WebTabsLayout() {
  const p = usePalette();
  return (
    <Tabs
      backBehavior="initialRoute"
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
          title: TAB_TITLES.index,
          tabBarIcon: ({ color, size }) => (
            <SpacesIcon color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="devices"
        options={{
          title: TAB_TITLES.devices,
          tabBarIcon: ({ color, size }) => (
            <DevicesIcon color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: TAB_TITLES.settings,
          tabBarIcon: ({ color, size }) => (
            <SettingsIcon color={color} size={size} />
          ),
        }}
      />
    </Tabs>
  );
}

export default function TabsLayout() {
  return process.env.EXPO_OS === 'web' ? (
    <WebTabsLayout />
  ) : (
    <NativeTabsLayout />
  );
}
