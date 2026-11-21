/**
 * Web: a pill (an optional Lucide icon before the label) that opens the
 * sheet as a modal: a card over a dimmed window, centered; Escape, the
 * backdrop or a pick close it.
 */
import { Pressable, Text } from 'react-native';
import { usePalette } from '../../ui/theme';
import { SymbolImage } from '../symbol-image';
import { useSheet } from './sheet-host';
import type { SheetChipProps } from './types';

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
  const p = usePalette();
  const s = useSheet(sheet, space);
  return (
    <>
      <Pressable
        accessibilityRole={fixed ? 'text' : 'button'}
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ expanded: s.isOpen, disabled: !!disabled }}
        testID={testID}
        disabled={disabled || fixed}
        onPress={s.open}
        className={`h-[30px] max-w-60 flex-row items-center gap-1 rounded-full bg-secondary px-2.5 ${fixed ? '' : 'hover:opacity-90 active:opacity-75'} ${disabled ? 'opacity-45' : ''}`}
      >
        {icon ? <SymbolImage name={icon} size={13} color={p.text} /> : null}
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
        {fixed ? null : (
          <Text className="text-[13px] text-muted-foreground">⌄</Text>
        )}
      </Pressable>
      {fixed ? null : s.element}
    </>
  );
}
