// Adapted from EvanBacon/chat-template (MIT)
/**
 * The model sheet as a route (the template's model-picker): iOS presents it
 * as a formSheet, medium / large detents, a grabber, Liquid Glass on iOS
 * 26+ (`./_layout.tsx`). Android and web open it in place from the chip
 * (`src/components/pickers/sheet-chip.*`).
 *
 * ```text
 * /model-picker             Home's draft
 * /model-picker?space=<id>  that space's pick (from its next message on)
 * ```
 */
import { router, useLocalSearchParams } from 'expo-router';
import { ScrollView } from 'react-native';
import { ModelPickerList } from '../../src/components/pickers/model-picker-list';

export default function ModelPickerRoute() {
  const { space } = useLocalSearchParams<{ space?: string }>();
  return (
    <ScrollView
      className="flex-1"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="android:pb-safe"
    >
      <ModelPickerList
        space={space || null}
        onClose={() => {
          if (router.canGoBack()) router.back();
        }}
      />
    </ScrollView>
  );
}
