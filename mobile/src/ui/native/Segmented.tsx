/** Web: joined segments in React Native (the iOS segmented control look). */
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { usePalette } from '../theme';
import { useInForm } from './context';
import type { SegmentedProps } from './types';

export function Segmented<T extends string>({
  label,
  choices,
  value,
  onChange,
  disabled,
  accessibilityLabel,
  testID,
  style,
}: SegmentedProps<T>) {
  const p = usePalette();
  const inForm = useInForm();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel ?? label}
      testID={testID}
      style={[
        styles.track,
        { backgroundColor: p.surfaceMuted, opacity: disabled ? 0.45 : 1 },
        inForm && styles.inForm,
        style,
      ]}
    >
      {choices.map((c) => {
        const on = c.value === value;
        return (
          <Pressable
            key={c.value}
            accessibilityRole="radio"
            accessibilityLabel={c.accessibilityLabel ?? c.label}
            accessibilityState={{ selected: on, disabled: !!disabled }}
            disabled={disabled}
            onPress={() => onChange(c.value)}
            style={[styles.segment, on && { backgroundColor: p.surface }]}
          >
            <Text
              numberOfLines={1}
              style={[
                styles.text,
                { color: p.text, fontWeight: on ? '600' : '400' },
              ]}
            >
              {c.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    borderRadius: 9,
    borderCurve: 'continuous',
    padding: 2,
    gap: 2,
  },
  inForm: { marginHorizontal: 16, marginVertical: 8 },
  segment: {
    flex: 1,
    minHeight: 32,
    borderRadius: 7,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  text: { fontSize: 14 },
});
