// Adapted from EvanBacon/chat-template (MIT)
/**
 * The account at the top of Settings (the template's email card, with an
 * avatar):
 *
 * ```text
 * ╭──────────────────────────────────────╮
 * │ (JI)  Jean Isahakyan                 │
 * │       jean@example.com               │
 * │       ▦ Acme · Admin                 │
 * ╰──────────────────────────────────────╯
 * ```
 */
import { Text, View } from 'react-native';
import type { AccountView } from '../../ui/settingsView';
import { usePalette } from '../../ui/theme';
import { SymbolImage } from '../symbol-image';

const android = process.env.EXPO_OS === 'android';

export function AccountCard({ account }: { account: AccountView }) {
  const p = usePalette();
  const org = [account.organization, account.role].filter(Boolean).join(' · ');
  return (
    <View
      accessible
      accessibilityLabel={[`Signed in as ${account.title}`, account.email, org]
        .filter(Boolean)
        .join(', ')}
      testID="settings-account"
      className={
        android
          ? 'mx-4 mt-2 mb-3 flex-row items-center gap-4 rounded-3xl bg-muted p-4'
          : 'mx-5 mt-4 mb-4 flex-row items-center gap-4 rounded-2xl bg-muted px-4 py-4'
      }
      style={{ borderCurve: 'continuous' }}
    >
      <View className="h-14 w-14 items-center justify-center rounded-full bg-primary">
        <Text className="text-xl font-semibold text-primary-foreground">
          {account.initials}
        </Text>
      </View>
      <View className="flex-1 gap-0.5">
        <Text
          numberOfLines={1}
          className="text-xl font-semibold text-foreground"
        >
          {account.title}
        </Text>
        {account.email ? (
          <Text
            selectable
            numberOfLines={1}
            className="text-[15px] text-muted-foreground"
          >
            {account.email}
          </Text>
        ) : null}
        {org ? (
          <View className="mt-0.5 flex-row items-center gap-1.5">
            <SymbolImage name="organization" size={13} color={p.muted} />
            <Text
              numberOfLines={1}
              className="flex-1 text-[13px] text-muted-foreground"
            >
              {org}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}
