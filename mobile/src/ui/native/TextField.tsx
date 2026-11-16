/** Web: React Native `TextInput` with the kit's field look. */
import { StyleSheet, TextInput } from 'react-native';
import { usePalette } from '../theme';
import { useInForm } from './context';
import type { TextFieldProps } from './types';

export function TextField({
  value,
  onChangeText,
  placeholder,
  multiline,
  minLines = 3,
  maxLines = 8,
  onSubmit,
  submitLabel,
  autoFocus,
  disabled,
  maxLength,
  autoCapitalize,
  autoCorrect,
  accessibilityLabel,
  testID,
  style,
}: TextFieldProps) {
  const p = usePalette();
  const inForm = useInForm();
  const line = 22;
  return (
    <TextInput
      accessibilityLabel={accessibilityLabel ?? placeholder}
      testID={testID}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={p.muted}
      multiline={multiline}
      numberOfLines={multiline ? minLines : undefined}
      autoFocus={autoFocus}
      editable={!disabled}
      maxLength={maxLength}
      autoCapitalize={autoCapitalize}
      autoCorrect={autoCorrect}
      returnKeyType={submitLabel === 'next' ? 'next' : submitLabel}
      onSubmitEditing={multiline ? undefined : onSubmit}
      style={[
        styles.field,
        inForm
          ? styles.inForm
          : {
              backgroundColor: p.surface,
              borderColor: p.border,
              borderWidth: StyleSheet.hairlineWidth,
            },
        multiline && {
          minHeight: minLines * line + 20,
          maxHeight: maxLines * line + 20,
          textAlignVertical: 'top',
        },
        { color: p.text, opacity: disabled ? 0.45 : 1 },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  field: {
    minHeight: 44,
    borderRadius: 12,
    borderCurve: 'continuous',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    lineHeight: 22,
  },
  inForm: { borderRadius: 0, paddingHorizontal: 16 },
});
