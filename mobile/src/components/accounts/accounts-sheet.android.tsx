/**
 * Android: the accounts sheet in Compose (inside a `ModalBottomSheet`);
 * the same rows and steps as `accounts-list.tsx`.
 */
import { Box, Column, Row, Text } from '@expo/ui/jetpack-compose';
import {
  Shapes,
  background,
  clip,
  fillMaxWidth,
  padding,
  semantics,
  size,
  verticalScroll,
  weight,
} from '@expo/ui/jetpack-compose/modifiers';
import { tick } from '../pickers/haptics';
import {
  SheetBack,
  SheetDivider,
  SheetRow,
  SheetTitle,
} from '../pickers/sheet-parts.android';
import {
  CHOOSE_LEAD,
  CHOOSE_TITLE,
  SHEET_TITLE,
  type AccountsRow,
} from '../../ui/accountsSheet';
import { usePalette } from '../../ui/theme';
import { useAccountsSheet } from './use-accounts';

const COLUMN = [fillMaxWidth(), verticalScroll(), padding(0, 0, 0, 24)];

function AccountHead({
  row,
}: {
  row: Extract<AccountsRow, { kind: 'account' }>;
}) {
  const p = usePalette();
  return (
    <Row
      verticalAlignment="center"
      horizontalArrangement={{ spacedBy: 14 }}
      modifiers={[
        fillMaxWidth(),
        padding(24, 16, 24, 4),
        semantics({
          contentDescription: [
            row.label,
            row.email,
            row.active ? 'active' : null,
          ]
            .filter(Boolean)
            .join(', '),
        }),
      ]}
    >
      <Box
        modifiers={[
          size(36, 36),
          clip(Shapes.Circle),
          background(row.active ? p.accent : p.border),
        ]}
      >
        <Column
          verticalArrangement="center"
          horizontalAlignment="center"
          modifiers={[size(36, 36)]}
        >
          <Text
            color={row.active ? p.background : p.text}
            style={{ typography: 'labelLarge' }}
          >
            {row.initials}
          </Text>
        </Column>
      </Box>
      <Column modifiers={[weight(1)]}>
        <Text color={p.text} maxLines={1} style={{ typography: 'titleMedium' }}>
          {row.label}
        </Text>
        {row.email ? (
          <Text
            color={p.muted}
            maxLines={1}
            style={{ typography: 'bodySmall' }}
          >
            {row.email}
          </Text>
        ) : null}
      </Column>
    </Row>
  );
}

export function AccountsSheet({ onClose }: { onClose: () => void }) {
  const p = usePalette();
  const sheet = useAccountsSheet(onClose);

  if (sheet.step.kind === 'choose') {
    return (
      <Column modifiers={COLUMN}>
        <SheetTitle
          leading={<SheetBack label={SHEET_TITLE} onPress={sheet.backToList} />}
        >
          {CHOOSE_TITLE}
        </SheetTitle>
        <Text color={p.muted} modifiers={[padding(24, 0, 24, 8)]}>
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
      </Column>
    );
  }

  return (
    <Column modifiers={COLUMN}>
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
              />
            );
          case 'add':
            return (
              <SheetRow
                key="add"
                label={`+ ${r.label}`}
                accent
                disabled={!!sheet.busy && sheet.busy !== 'add'}
                value={sheet.busy === 'add' ? 'Signing in…' : null}
                accessibilityLabel={r.label}
                onPress={sheet.add}
              />
            );
          case 'sign-out':
            return (
              <Column key="sign-out" modifiers={[fillMaxWidth()]}>
                <SheetDivider />
                <SheetRow
                  label={r.label}
                  disabled={!!sheet.busy && sheet.busy !== r.userId}
                  onPress={sheet.signOut}
                />
              </Column>
            );
        }
      })}
      {sheet.error ? (
        <Text color={p.danger} modifiers={[padding(24, 12, 24, 0)]}>
          {sheet.error}
        </Text>
      ) : null}
    </Column>
  );
}
