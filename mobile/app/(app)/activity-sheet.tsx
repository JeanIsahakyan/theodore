/**
 * The activity sheet as a route (iOS presents it as a formSheet with
 * medium / large detents and a grabber, `./_layout.tsx`; Android and web
 * open theirs in place from the strip).
 *
 * ```text
 * /activity-sheet?space=<id>   that space's plan, subagents and sub-spaces
 * ```
 */
import { router, useLocalSearchParams } from 'expo-router';
import { ScrollView } from 'react-native';
import { ActivitySheet } from '../../src/ui/ActivitySheet';

export default function ActivitySheetRoute() {
  const { space } = useLocalSearchParams<{ space?: string }>();
  return (
    <ScrollView
      className="flex-1"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="android:pb-safe"
    >
      <ActivitySheet
        space={space ?? ''}
        onClose={() => {
          if (router.canGoBack()) router.back();
        }}
      />
    </ScrollView>
  );
}
