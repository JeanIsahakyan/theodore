/**
 * Web (and the type every platform shares): the React Native button of
 * `../kit`. glass / glassProminent look like secondary / primary. In a
 * `Form` section's card: a row; in a `plain` section, the button itself.
 */
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { usePalette } from '../theme';
import { useInCard, useInForm } from './context';
import { webStyles } from './rnStyles';
import type { ButtonProps } from './types';

export function Button({
  label,
  onPress,
  variant = 'secondary',
  disabled,
  loading,
  fullWidth,
  pill,
  accessibilityLabel,
  testID,
  style,
}: ButtonProps) {
  const p = usePalette();
  const inForm = useInForm();
  const inCard = useInCard();
  const off = !!disabled || !!loading;
  const danger = variant === 'destructive';
  const look =
    variant === 'glass'
      ? 'secondary'
      : variant === 'glassProminent'
        ? 'primary'
        : variant;

  if (inForm && inCard) {
    const color = danger ? p.danger : p.accent;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityState={{ disabled: off, busy: !!loading }}
        testID={testID}
        disabled={off}
        onPress={onPress}
        style={({ pressed }) => [
          webStyles.row,
          { opacity: off ? 0.45 : 1 },
          pressed && { backgroundColor: p.surfaceMuted },
        ]}
      >
        <Text style={[webStyles.rowLabel, { color, flex: 1 }]}>{label}</Text>
        {loading ? <ActivityIndicator size="small" color={color} /> : null}
      </Pressable>
    );
  }

  // Destructive is the quieter action (Untrust): outlined, red text.
  const bg =
    look === 'primary'
      ? p.accent
      : look === 'secondary'
        ? p.surfaceMuted
        : 'transparent';
  const fg =
    look === 'primary'
      ? p.onAccent
      : danger
        ? p.danger
        : look === 'plain'
          ? p.accent
          : p.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: off, busy: !!loading }}
      testID={testID}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        pill ? styles.pill : null,
        fullWidth ? styles.full : null,
        { backgroundColor: bg, opacity: off ? 0.45 : pressed ? 0.75 : 1 },
        danger ? { borderWidth: 1, borderColor: p.border } : null,
        style,
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={fg} /> : null}
      <Text style={[styles.text, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderCurve: 'continuous',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  pill: { minHeight: 36, borderRadius: 999, paddingHorizontal: 14 },
  full: { alignSelf: 'stretch' },
  text: { fontSize: 16, fontWeight: '600' },
});
