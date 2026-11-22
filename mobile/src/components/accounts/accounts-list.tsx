/**
 * The accounts sheet in React Native (the iOS formSheet route, the web
 * modal); Android draws the same in Compose (`accounts-sheet.android.tsx`).
 * Rows: `src/ui/accountsSheet.ts`; state: `./use-accounts.ts`.
 */
import { Text, View } from 'react-native';
import { tick } from '../pickers/haptics';
import {
  SheetBack,
  SheetDivider,
  SheetRow,
  SheetTitle,
} from '../pickers/sheet-rows';
import {
  CHOOSE_LEAD,
  CHOOSE_TITLE,
  SHEET_TITLE,
  type AccountsRow,
} from '../../ui/accountsSheet';
import { useAccountsSheet } from './use-accounts';

function AccountHead({
  row,
}: {
  row: Extract<AccountsRow, { kind: 'account' }>;
}) {
  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={[row.label, row.email, row.active ? 'active' : null]
        .filter(Boolean)
        .join(', ')}
      testID={`account-${row.userId}`}
      className="flex-row items-center gap-3.5 px-5 pt-4 pb-1"
    >
      <View
        className={`h-9 w-9 items-center justify-center rounded-full ${row.active ? 'bg-primary' : 'bg-muted'}`}
      >
        <Text
          className={`text-[14px] font-semibold ${row.active ? 'text-primary-foreground' : 'text-foreground'}`}
        >
          {row.initials}
        </Text>
      </View>
      <View className="flex-1">
        <Text
          numberOfLines={1}
          className="text-[17px] font-semibold text-foreground"
        >
          {row.label}
        </Text>
        {row.email ? (
          <Text numberOfLines={1} className="text-[13px] text-muted-foreground">
            {row.email}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export function AccountsList({ onClose }: { onClose: () => void }) {
  const sheet = useAccountsSheet(onClose);

  if (sheet.step.kind === 'choose') {
    return (
      <View className="pb-6" testID="accounts-choose-organization">
        <SheetTitle
          leading={<SheetBack label={SHEET_TITLE} onPress={sheet.backToList} />}
        >
          {CHOOSE_TITLE}
        </SheetTitle>
        <Text className="px-5 pb-2 text-[13px] text-muted-foreground">
          {sheet.error ?? CHOOSE_LEAD}
        </Text>
        {sheet.step.organizations.map((o) => (
          <SheetRow
            key={o.id}
            label={o.name || 'Unnamed organization'}
            chevron
            disabled={!!sheet.busy && sheet.busy !== o.id}
            value={sheet.busy === o.id ? 'Signing in…' : null}
            accessibilityLabel={`Use ${o.name || o.id}`}
            onPress={() => sheet.chooseOrganization(o.id)}
          />
        ))}
      </View>
    );
  }

  return (
    <View className="pb-6" testID="accounts-sheet">
      <SheetTitle>{SHEET_TITLE}</SheetTitle>
      {sheet.rows.map((r) => {
        switch (r.kind) {
          case 'account':
            return <AccountHead key={`a-${r.userId}`} row={r} />;
          case 'org':
            return (
              <SheetRow
                key={`o-${r.userId}-${r.orgId}`}
                label={r.name}
                selected={r.selected}
                disabled={!!sheet.busy && sheet.busy !== r.orgId}
                value={sheet.busy === r.orgId ? 'Switching…' : null}
                accessibilityLabel={r.accessibilityLabel}
                onPress={() => {
                  tick();
                  sheet.switchTo(r);
                }}
              />
            );
          case 'reauth':
            return (
              <SheetRow
                key={`r-${r.userId}`}
                label={r.label}
                accent
                disabled={!!sheet.busy && sheet.busy !== r.userId}
                accessibilityLabel={`${r.label} for this account`}
                onPress={() => sheet.signInAgain(r.userId)}
                testID={`account-reauth-${r.userId}`}
              />
            );
          case 'add':
            return (
              <View key="add" className="pt-2">
                <SheetRow
                  label={`+ ${r.label}`}
                  accent
                  disabled={!!sheet.busy && sheet.busy !== 'add'}
                  value={sheet.busy === 'add' ? 'Signing in…' : null}
                  accessibilityLabel={r.label}
                  onPress={sheet.add}
                  testID="accounts-add"
                />
              </View>
            );
          case 'sign-out':
            return (
              <View key="sign-out">
                <SheetDivider />
                <SheetRow
                  label={r.label}
                  disabled={!!sheet.busy && sheet.busy !== r.userId}
                  onPress={sheet.signOut}
                  testID="accounts-sign-out"
                />
              </View>
            );
        }
      })}
      {sheet.error ? (
        <Text
          accessibilityRole="alert"
          selectable
          className="px-5 pt-3 text-[13px] text-danger"
        >
          {sheet.error}
        </Text>
      ) : null}
    </View>
  );
}
