/**
 * Web: a row showing the choice; tapping it lists the choices under it
 * (checkmark on the chosen one), tapping one picks it and closes the list.
 */
import { Fragment, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { usePalette } from '../theme';
import { useInForm } from './context';
import { webStyles } from './rnStyles';
import type { SelectProps } from './types';

export function Select<T extends string>({
  label,
  choices,
  value,
  onChange,
  placeholder = 'Choose…',
  disabled,
  accessibilityLabel,
  testID,
  style,
}: SelectProps<T>) {
  const p = usePalette();
  const inForm = useInForm();
  const [open, setOpen] = useState(false);
  const shown = choices.find((c) => c.value === value)?.label;
  const separator = (
    <View style={[webStyles.separator, { backgroundColor: p.border }]} />
  );
  return (
    <View
      style={[
        !inForm && [webStyles.card, { backgroundColor: p.surface }],
        style,
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityHint={shown ?? placeholder}
        accessibilityState={{ expanded: open, disabled: !!disabled }}
        testID={testID}
        disabled={disabled}
        onPress={() => setOpen((o) => !o)}
        style={({ pressed }) => [
          webStyles.row,
          { opacity: disabled ? 0.45 : 1 },
          pressed && { backgroundColor: p.surfaceMuted },
        ]}
      >
        <Text style={[webStyles.rowLabel, { color: p.text, flex: 1 }]}>
          {label}
        </Text>
        <Text
          numberOfLines={1}
          style={[webStyles.rowValue, { color: shown ? p.accent : p.muted }]}
        >
          {shown ?? placeholder}
        </Text>
        <Text style={[styles.updown, { color: p.muted }]}>
          {open ? '⌃' : '⌄'}
        </Text>
      </Pressable>
      {open
        ? choices.map((c) => (
            <Fragment key={c.value}>
              {separator}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={c.accessibilityLabel ?? c.label}
                accessibilityState={{ selected: c.value === value }}
                onPress={() => {
                  setOpen(false);
                  onChange(c.value);
                }}
                style={({ pressed }) => [
                  webStyles.row,
                  styles.option,
                  pressed && { backgroundColor: p.surfaceMuted },
                ]}
              >
                <Text style={[webStyles.rowLabel, { color: p.text, flex: 1 }]}>
                  {c.label}
                </Text>
                {c.value === value ? (
                  <Text style={[webStyles.rowLabel, { color: p.accent }]}>
                    ✓
                  </Text>
                ) : null}
              </Pressable>
            </Fragment>
          ))
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  updown: { fontSize: 15, width: 14, textAlign: 'center' },
  option: { paddingLeft: 32 },
});
