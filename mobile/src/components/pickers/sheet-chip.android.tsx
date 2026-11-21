/**
 * Android: a Material 3 `AssistChip` (an optional Material Symbol as its
 * leading icon) that opens a Material 3 `ModalBottomSheet` (Compose: drag
 * handle, scrim, swipe / Back / the scrim dismiss it), the sheet drawn in
 * Compose too (`sheet-host.android.tsx`).
 *
 * Handlers inside call store actions with fixed ids (`applyModel(space,
 * agent, model)`), which read the picks when they run: Compose may keep
 * the handler it was mounted with.
 */
import { AssistChip, Host, Icon, Row, Text } from '@expo/ui/jetpack-compose';
import {
  semantics,
  testID as testIDMod,
} from '@expo/ui/jetpack-compose/modifiers';
import type { ImageSourcePropType } from 'react-native';
import { useHostTheme } from '../../ui/native/host.android';
import { usePalette } from '../../ui/theme';
import type { SymbolName } from '../symbol-image';
import { useSheetState } from './sheet-host.android';
import type { SheetChipProps } from './types';

/** The chips' icons as vector drawables (Compose can't draw `SymbolImage`). */
const ICONS: Partial<Record<SymbolName, ImageSourcePropType>> = {
  folder: require('../../../assets/icons/folder.xml'),
  computer: require('../../../assets/icons/computer.xml'),
};

export function SheetChip({
  sheet,
  space,
  icon,
  label,
  detail,
  accessibilityLabel,
  fixed,
  disabled,
  testID,
}: SheetChipProps) {
  const theme = useHostTheme();
  const p = usePalette();
  const { setOpen, sheet: drawSheet } = useSheetState();
  const source = icon ? ICONS[icon] : undefined;
  const off = disabled || fixed;
  return (
    <Host {...theme} matchContents>
      <AssistChip
        // Remounted when it turns on or off (Compose keeps the first handler).
        key={off ? 'off' : 'on'}
        enabled={!disabled}
        onClick={off ? undefined : () => setOpen(true)}
        modifiers={[
          semantics({ contentDescription: accessibilityLabel }),
          ...(testID ? [testIDMod(testID)] : []),
        ]}
      >
        {source ? (
          <AssistChip.LeadingIcon>
            <Icon source={source} size={18} tint={p.text} />
          </AssistChip.LeadingIcon>
        ) : null}
        <AssistChip.Label>
          <Row horizontalArrangement={{ spacedBy: 4 }}>
            <Text maxLines={1} style={{ typography: 'labelMedium' }}>
              {label}
            </Text>
            {detail ? (
              <Text
                maxLines={1}
                color={p.muted}
                style={{ typography: 'labelMedium' }}
              >
                {detail}
              </Text>
            ) : null}
          </Row>
        </AssistChip.Label>
        {fixed ? null : (
          <AssistChip.TrailingIcon>
            <Text>▾</Text>
          </AssistChip.TrailingIcon>
        )}
      </AssistChip>
      {fixed ? null : drawSheet(sheet, space)}
    </Host>
  );
}
