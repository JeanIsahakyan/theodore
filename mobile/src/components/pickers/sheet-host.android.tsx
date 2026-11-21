/**
 * Android: a sheet is a Material 3 `ModalBottomSheet` in place (Compose:
 * drag handle, scrim, swipe / Back / the scrim dismiss it), its content in
 * Compose. A pick that closes it hides the sheet with its animation first.
 */
import {
  Host,
  ModalBottomSheet,
  type ModalBottomSheetRef,
} from '@expo/ui/jetpack-compose';
import { useRef, useState } from 'react';
import { ActivitySheet } from '../../ui/ActivitySheet';
import { useHostTheme } from '../../ui/native/host.android';
import { ModelPickerSheet } from './model-picker-sheet.android';
import type { SheetHandle, SheetKind } from './types';
import {
  ComputerPickerSheet,
  ProjectPickerSheet,
} from './where-picker-sheet.android';

export function SheetContent({
  kind,
  space,
  onClose,
}: {
  kind: SheetKind;
  space?: string | null;
  onClose: () => void;
}) {
  if (kind === 'model')
    return <ModelPickerSheet space={space ?? null} onClose={onClose} />;
  if (kind === 'activity')
    return <ActivitySheet space={space ?? ''} onClose={onClose} />;
  if (kind === 'computer') return <ComputerPickerSheet onClose={onClose} />;
  return <ProjectPickerSheet onClose={onClose} />;
}

/** The sheet's state; `sheet(…)` draws it inside a Compose `Host`. */
export function useSheetState() {
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
  const sheet = (kind: SheetKind, space?: string | null) =>
    open ? (
      <ModalBottomSheet ref={ref} onDismissRequest={() => setOpen(false)}>
        <SheetContent kind={kind} space={space} onClose={close} />
      </ModalBottomSheet>
    ) : null;
  return { open, setOpen, sheet };
}

export function useSheet(kind: SheetKind, space?: string | null): SheetHandle {
  const theme = useHostTheme();
  const { open, setOpen, sheet } = useSheetState();
  return {
    open: () => setOpen(true),
    isOpen: open,
    element: open ? (
      <Host {...theme} matchContents>
        {sheet(kind, space)}
      </Host>
    ) : null,
  };
}
