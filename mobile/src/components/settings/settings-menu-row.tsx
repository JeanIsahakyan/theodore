// Adapted from EvanBacon/chat-template (MIT)
/**
 * Web: a settings row showing the choice ("Appearance   System ⌃⌄") that
 * unfolds the choices under it, a check on the current one. iOS draws a
 * SwiftUI `Menu` (`.ios.tsx`), Android a Material 3 dropdown
 * (`.android.tsx`).
 */
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { usePalette } from '../../ui/theme';
import { SymbolImage } from '../symbol-image';
import { tick } from './feedback';
import { LABEL_CLASS, ROW_CLASS, ROW_ICON_SIZE } from './settings-row';
import type { SettingsMenuRowProps } from './types';

export function SettingsMenuRow<T extends string>({
  icon,
  label,
  choices,
  value,
  onChange,
  testID,
}: SettingsMenuRowProps<T>) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  const shown = choices.find((c) => c.value === value)?.label ?? '';
  return (
    <View>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${shown}`}
        accessibilityState={{ expanded: open }}
        testID={testID}
        className={`${ROW_CLASS} active:bg-muted`}
      >
        <SymbolImage name={icon} size={ROW_ICON_SIZE} color={p.text} />
        <Text className={`flex-1 ${LABEL_CLASS}`}>{label}</Text>
        <Text className="text-[15px] text-muted-foreground">{shown}</Text>
        <SymbolImage name="chevron.up.chevron.down" size={13} color={p.muted} />
      </Pressable>
      {open
        ? choices.map((c) => (
            <Pressable
              key={c.value}
              onPress={() => {
                setOpen(false);
                if (c.value === value) return;
                tick();
                onChange(c.value);
              }}
              accessibilityRole="radio"
              accessibilityLabel={c.accessibilityLabel ?? c.label}
              accessibilityState={{ checked: c.value === value }}
              className="flex-row items-center gap-4 py-2.5 pr-5 pl-[60px] active:bg-muted"
            >
              <Text
                className={`flex-1 text-[15px] ${c.value === value ? 'text-primary' : 'text-foreground'}`}
              >
                {c.label}
              </Text>
              {c.value === value ? (
                <SymbolImage name="check" size={15} color={p.accent} />
              ) : null}
            </Pressable>
          ))
        : null}
    </View>
  );
}
