/** Web (and the type every platform shares): the React Native button of `../kit`. */
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { usePalette } from '../theme';
import { useInForm } from './context';
import { webStyles } from './rnStyles';
import type { ButtonProps } from './types';

export function Button({
  label,
  onPress,
  variant = 'secondary',
  disabled,
  loading,
  fullWidth,
  accessibilityLabel,
  testID,
  style,
}: ButtonProps) {
  const p = usePalette();
  const inForm = useInForm();
  const off = !!disabled || !!loading;
  const danger = variant === 'destructive';

  if (inForm) {
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

  const bg =
    variant === 'primary'
      ? p.accent
      : danger
        ? p.danger
        : variant === 'secondary'
          ? p.surfaceMuted
          : 'transparent';
  const fg =
    variant === 'primary' || danger
      ? p.onAccent
      : variant === 'plain'
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
        fullWidth ? styles.full : null,
        { backgroundColor: bg, opacity: off ? 0.45 : pressed ? 0.75 : 1 },
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
  full: { alignSelf: 'stretch' },
  text: { fontSize: 16, fontWeight: '600' },
});
