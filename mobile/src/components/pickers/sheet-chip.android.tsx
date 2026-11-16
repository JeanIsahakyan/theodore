/**
 * Android: a Material 3 `AssistChip` that opens a Material 3
 * `ModalBottomSheet` (Compose: drag handle, scrim, swipe / Back / the scrim
 * dismiss it), the sheet drawn in Compose too. A pick that closes it hides
 * the sheet with its animation first.
 *
 * Handlers inside call store actions with fixed ids (`applyModel(space,
 * agent, model)`), which read the picks when they run: Compose may keep
 * the handler it was mounted with.
 */
import {
  AssistChip,
  Host,
  ModalBottomSheet,
  Text,
  type ModalBottomSheetRef,
} from '@expo/ui/jetpack-compose';
import {
  semantics,
  testID as testIDMod,
} from '@expo/ui/jetpack-compose/modifiers';
import { useRef, useState } from 'react';
import { useHostTheme } from '../../ui/native/host.android';
import { ModelPickerSheet } from './model-picker-sheet.android';
import type { SheetChipProps } from './types';
import { WherePickerSheet } from './where-picker-sheet.android';

export function SheetChip({
  sheet,
  space,
  label,
  accessibilityLabel,
  disabled,
  testID,
}: SheetChipProps) {
  const theme = useHostTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<ModalBottomSheetRef>(null);
  const close = () => {
    const s = ref.current;
    if (!s) return setOpen(false);
    void s
      .hide()
      .catch(() => {})
      .finally(() => setOpen(false));
  };
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
          <Text maxLines={1}>{label}</Text>
        </AssistChip.Label>
        <AssistChip.TrailingIcon>
          <Text>▾</Text>
        </AssistChip.TrailingIcon>
      </AssistChip>
      {open ? (
        <ModalBottomSheet ref={ref} onDismissRequest={() => setOpen(false)}>
          {sheet === 'model' ? (
            <ModelPickerSheet space={space ?? null} onClose={close} />
          ) : (
            <WherePickerSheet onClose={close} />
          )}
        </ModalBottomSheet>
      ) : null}
    </Host>
  );
}
