/**
 * The accounts sheet as a route (docs/mobile.md "Several accounts"): iOS
 * presents it as a formSheet like the picker sheets (`./_layout.tsx`).
 * Android and web open it in place from the drawer's account row and the
 * Settings "Accounts" row (`src/components/pickers/sheet-host.*`).
 */
import { router } from 'expo-router';
import { ScrollView } from 'react-native';
import { AccountsList } from '../../src/components/accounts/accounts-list';

export default function AccountsSheetRoute() {
  return (
    <ScrollView
      className="flex-1"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="android:pb-safe"
    >
      <AccountsList
        onClose={() => {
          if (router.canGoBack()) router.back();
        }}
      />
    </ScrollView>
  );
}
