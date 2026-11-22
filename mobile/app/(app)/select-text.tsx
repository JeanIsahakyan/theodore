/**
 * The Select text sheet as a route (iOS presents it as a formSheet with
 * medium / large detents and a grabber, `./_layout.tsx`; Android and web
 * open theirs in place from the long-pressed message). The text is in
 * `src/state/selectText.ts`, set by the message before it opened this.
 *
 * ```text
 * /select-text   the long-pressed message, as selectable plain text
 * ```
 */
import { router } from 'expo-router';
import { ScrollView } from 'react-native';
import { SelectTextSheet } from '../../src/components/chat/select-text-sheet';

export default function SelectTextRoute() {
  return (
    <ScrollView
      className="flex-1"
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
      <SelectTextSheet
        onClose={() => {
          if (router.canGoBack()) router.back();
        }}
      />
    </ScrollView>
  );
}
