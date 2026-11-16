/**
 * Android: a scrolling Compose `Column` in a `Host` that fills the screen;
 * `Section` ─▶ a titled `Card`, `Row` ─▶ Material 3 `ListItem`,
 * `FormSlot` ─▶ `RNHostView`.
 */
import {
  Card,
  CircularProgressIndicator,
  Column,
  Host,
  ListItem,
  RNHostView,
  Row as CRow,
  Text,
} from '@expo/ui/jetpack-compose';
import {
  alpha,
  clickable,
  fillMaxWidth,
  padding,
  paddingAll,
  semantics,
  size,
  testID as testIDMod,
  verticalScroll,
  type ModifierConfig,
} from '@expo/ui/jetpack-compose/modifiers';
import { View } from 'react-native';
import { usePalette } from '../theme';
import { InForm } from './context';
import { useHostTheme } from './host.android';
import type { FormProps, FormSlotProps, RowProps, SectionProps } from './types';

export function Form({ children, testID }: FormProps) {
  const theme = useHostTheme();
  const p = usePalette();
  return (
    <Host {...theme} style={{ flex: 1, backgroundColor: p.background }}>
      <Column
        verticalArrangement={{ spacedBy: 20 }}
        modifiers={[
          verticalScroll(),
          paddingAll(16),
          ...(testID ? [testIDMod(testID)] : []),
        ]}
      >
        <InForm.Provider value>{children}</InForm.Provider>
      </Column>
    </Host>
  );
}

export function Section({ title, footer, children }: SectionProps) {
  const p = usePalette();
  return (
    <Column verticalArrangement={{ spacedBy: 8 }} modifiers={[fillMaxWidth()]}>
      {title ? (
        <Text
          color={p.accent}
          style={{ typography: 'labelLarge' }}
          modifiers={[padding(16, 0, 16, 0)]}
        >
          {title}
        </Text>
      ) : null}
      <Card colors={{ containerColor: p.surface }} modifiers={[fillMaxWidth()]}>
        <Column>{children}</Column>
      </Card>
      {footer ? (
        <Text
          color={p.muted}
          style={{ typography: 'bodySmall' }}
          modifiers={[padding(16, 0, 16, 0)]}
        >
          {footer}
        </Text>
      ) : null}
    </Column>
  );
}

export function Row({
  label,
  detail,
  value,
  onPress,
  selected,
  destructive,
  loading,
  disabled,
  accessibilityLabel,
  testID,
}: RowProps) {
  const p = usePalette();
  const off = !!disabled || !!loading;
  const mods: ModifierConfig[] = [];
  if (onPress && !off) mods.push(clickable(onPress));
  if (disabled) mods.push(alpha(0.38));
  if (accessibilityLabel)
    mods.push(semantics({ contentDescription: accessibilityLabel }));
  if (testID) mods.push(testIDMod(testID));
  const trailing =
    value != null || loading || selected ? (
      <CRow verticalAlignment="center" horizontalArrangement={{ spacedBy: 8 }}>
        {value != null ? <Text color={p.muted}>{value}</Text> : null}
        {loading ? (
          <CircularProgressIndicator
            strokeWidth={2}
            modifiers={[size(20, 20)]}
          />
        ) : selected ? (
          <Text color={p.accent}>✓</Text>
        ) : null}
      </CRow>
    ) : null;
  return (
    <ListItem colors={{ containerColor: 'transparent' }} modifiers={mods}>
      <ListItem.HeadlineContent>
        <Text color={destructive ? p.danger : p.text}>{label}</Text>
      </ListItem.HeadlineContent>
      {detail ? (
        <ListItem.SupportingContent>
          <Text color={p.muted}>{detail}</Text>
        </ListItem.SupportingContent>
      ) : null}
      {trailing ? (
        <ListItem.TrailingContent>{trailing}</ListItem.TrailingContent>
      ) : null}
    </ListItem>
  );
}

export function FormSlot({ children }: FormSlotProps) {
  return (
    <RNHostView matchContents={{ vertical: true }}>
      <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
        <InForm.Provider value={false}>{children}</InForm.Provider>
      </View>
    </RNHostView>
  );
}
