/**
 * Home's project sheet as a route: iOS presents it as a formSheet (medium /
 * large detents, a grabber, Liquid Glass on iOS 26+, `./_layout.tsx`).
 * Android and web open it in place (`src/components/pickers/sheet-host.*`).
 */
import { router } from 'expo-router';
import { ScrollView } from 'react-native';
import { ProjectPickerList } from '../../src/components/pickers/where-picker-list';

export default function ProjectPickerRoute() {
  return (
    <ScrollView
      className="flex-1"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="android:pb-safe"
      keyboardShouldPersistTaps="handled"
    >
      <ProjectPickerList
        onClose={() => {
          if (router.canGoBack()) router.back();
        }}
      />
    </ScrollView>
  );
}
