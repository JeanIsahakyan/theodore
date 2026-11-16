/**
 * Web: a pill (the Mode menu's look) that opens the sheet as a modal: a
 * card over a dimmed window, centered; Escape, the backdrop or a pick
 * close it.
 */
import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text } from 'react-native';
import { usePalette } from '../../ui/theme';
import { ModelPickerList } from './model-picker-list';
import type { SheetChipProps } from './types';
import { WherePickerList } from './where-picker-list';

export function SheetChip({
  sheet,
  space,
  label,
  accessibilityLabel,
  disabled,
  testID,
}: SheetChipProps) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ expanded: open, disabled: !!disabled }}
        testID={testID}
        disabled={disabled}
        onPress={() => setOpen(true)}
        className={`h-9 max-w-60 flex-row items-center gap-1.5 rounded-full bg-secondary px-3.5 hover:opacity-90 active:opacity-75 ${disabled ? 'opacity-45' : ''}`}
      >
        <Text
          numberOfLines={1}
          className="shrink text-[14px] font-medium text-foreground"
        >
          {label}
        </Text>
        <Text className="text-[14px] text-muted-foreground">⌄</Text>
      </Pressable>
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
            <ScrollView>
              {sheet === 'model' ? (
                <ModelPickerList space={space ?? null} onClose={close} />
              ) : (
                <WherePickerList onClose={close} />
              )}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
