/**
 * Android: a Material 3 `AssistChip` that opens a Material 3
 * `ModalBottomSheet` (Compose: drag handle, scrim, swipe / Back / the scrim
 * dismiss it), the sheet drawn in Compose too (`sheet-host.android.tsx`).
 *
 * Handlers inside call store actions with fixed ids (`applyModel(space,
 * agent, model)`), which read the picks when they run: Compose may keep
 * the handler it was mounted with.
 */
import { AssistChip, Host, Row, Text } from '@expo/ui/jetpack-compose';
import {
  semantics,
  testID as testIDMod,
} from '@expo/ui/jetpack-compose/modifiers';
import { useHostTheme } from '../../ui/native/host.android';
import { usePalette } from '../../ui/theme';
import { useSheetState } from './sheet-host.android';
import type { SheetChipProps } from './types';

export function SheetChip({
  sheet,
  space,
  label,
  detail,
  accessibilityLabel,
  disabled,
  testID,
}: SheetChipProps) {
  const theme = useHostTheme();
  const p = usePalette();
  const { setOpen, sheet: drawSheet } = useSheetState();
  return (
    <Host {...theme} matchContents>
      <AssistChip
        // Remounted when it turns on or off (Compose keeps the first handler).
        key={disabled ? 'off' : 'on'}
        enabled={!disabled}
        onClick={disabled ? undefined : () => setOpen(true)}
        modifiers={[
          semantics({ contentDescription: accessibilityLabel }),
          ...(testID ? [testIDMod(testID)] : []),
        ]}
      >
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
        <AssistChip.TrailingIcon>
          <Text>▾</Text>
        </AssistChip.TrailingIcon>
      </AssistChip>
      {drawSheet(sheet, space)}
    </Host>
  );
}
