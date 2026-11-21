/**
 * Web: a pill (the Mode menu's look) that opens the sheet as a modal: a
 * card over a dimmed window, centered; Escape, the backdrop or a pick
 * close it.
 */
import { Pressable, Text } from 'react-native';
import { useSheet } from './sheet-host';
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
  const s = useSheet(sheet, space);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ expanded: s.isOpen, disabled: !!disabled }}
        testID={testID}
        disabled={disabled}
        onPress={s.open}
        className={`h-[30px] max-w-60 flex-row items-center gap-1 rounded-full bg-secondary px-2.5 hover:opacity-90 active:opacity-75 ${disabled ? 'opacity-45' : ''}`}
      >
        <Text
          numberOfLines={1}
          className="shrink text-[13px] font-medium text-foreground"
        >
          {label}
        </Text>
        {detail ? (
          <Text numberOfLines={1} className="text-[13px] text-muted-foreground">
            {detail}
          </Text>
        ) : null}
        <Text className="text-[13px] text-muted-foreground">⌄</Text>
      </Pressable>
      {s.element}
    </>
  );
}
