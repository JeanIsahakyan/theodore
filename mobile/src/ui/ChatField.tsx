/**
 * Web (and the type every platform shares): React Native `TextInput` with
 * the kit's field look, a ref (`focus()`) and `onFocus` (see
 * `chatFieldTypes.ts`).
 */
import { useImperativeHandle, useRef } from 'react';
import { StyleSheet, TextInput, type TextInputInstance } from 'react-native';
import type { ChatFieldProps } from './chatFieldTypes';
import { usePalette } from './theme';

const LINE = 22;

export function ChatField({
  ref,
  value,
  onChangeText,
  onFocus,
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
}: ChatFieldProps) {
  const p = usePalette();
  const input = useRef<TextInputInstance>(null);
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), []);
  return (
    <TextInput
      ref={input}
      accessibilityLabel={accessibilityLabel ?? placeholder}
      testID={testID}
      value={value}
      onChangeText={onChangeText}
      onFocus={onFocus}
      placeholder={placeholder}
      placeholderTextColor={p.muted}
      multiline={multiline}
      numberOfLines={multiline ? minLines : undefined}
      autoFocus={autoFocus}
      editable={!disabled}
      maxLength={maxLength}
      autoCapitalize={autoCapitalize}
      autoCorrect={autoCorrect}
      returnKeyType={submitLabel}
      onSubmitEditing={multiline ? undefined : onSubmit}
      style={[
        styles.field,
        {
          backgroundColor: p.background,
          borderColor: p.border,
          color: p.text,
          opacity: disabled ? 0.45 : 1,
        },
        multiline && {
          minHeight: minLines * LINE + 20,
          maxHeight: maxLines * LINE + 20,
          textAlignVertical: 'top',
        },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  field: {
    minHeight: 44,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 20,
    borderCurve: 'continuous',
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
    lineHeight: LINE,
  },
});
