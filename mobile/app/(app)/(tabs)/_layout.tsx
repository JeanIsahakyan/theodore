/**
 * The three tabs: Spaces, Devices, Settings. Waiting questions sit under
 * the header of every tab. Screens without a tab (a space, Start a space)
 * live in the stack around this navigator (`../_layout.tsx`), so a screen
 * reader counts three tabs. Back from Devices or Settings goes to Spaces.
 */
import { Tabs } from 'expo-router/js-tabs';
import { Header, getHeaderTitle } from 'expo-router/react-navigation';
import { View } from 'react-native';
import {
  DevicesIcon,
  SettingsIcon,
  SpacesIcon,
} from '../../../src/shell/TabIcons';
import { QuestionsBanner } from '../../../src/ui/QuestionsBanner';
import { usePalette } from '../../../src/ui/theme';

export const unstable_settings = { anchor: 'index' };

export default function TabsLayout() {
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
    </Tabs>
  );
}
