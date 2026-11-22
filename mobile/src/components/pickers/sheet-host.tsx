/**
 * Web: a sheet is a modal card over a dimmed window, centered; Escape,
 * the backdrop or a pick close it.
 */
import { useState } from 'react';
import { Modal, Pressable, ScrollView } from 'react-native';
import { track } from '../../telemetry/log';
import { usePalette } from '../../ui/theme';
import { SheetList } from './sheet-list';
import type { SheetHandle, SheetKind } from './types';

export function useSheet(kind: SheetKind, space?: string | null): SheetHandle {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return {
    open: () => {
      track('sheet_opened', { kind });
      setOpen(true);
    },
    isOpen: open,
    element: (
      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={close}
      >
        <Pressable
          accessibilityLabel="Close"
          onPress={close}
          className="flex-1 items-center justify-center bg-black/30 p-6"
        >
          <Pressable
            // Taps inside the card don't close it.
            onPress={() => {}}
            className="max-h-[80%] w-full max-w-[420px] overflow-hidden rounded-2xl"
            style={{ backgroundColor: p.surface }}
          >
            <ScrollView keyboardShouldPersistTaps="handled">
              <SheetList kind={kind} space={space} onClose={close} />
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    ),
  };
}
