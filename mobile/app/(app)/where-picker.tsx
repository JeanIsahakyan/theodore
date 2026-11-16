/**
 * Home's where sheet as a route: iOS presents it as a formSheet (medium /
 * large detents, a grabber, Liquid Glass on iOS 26+, `./_layout.tsx`):
 * devices with an online dot ─▶ a device's projects. Android and web open
 * it in place from the chip (`src/components/pickers/sheet-chip.*`).
 */
import { router } from 'expo-router';
import { ScrollView } from 'react-native';
import { WherePickerList } from '../../src/components/pickers/where-picker-list';

export default function WherePickerRoute() {
  return (
    <ScrollView
      className="flex-1"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="android:pb-safe"
    >
      <WherePickerList
        onClose={() => {
          if (router.canGoBack()) router.back();
        }}
      />
    </ScrollView>
  );
}
