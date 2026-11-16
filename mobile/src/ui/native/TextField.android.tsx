/**
 * Android: Material 3 `OutlinedTextField`. The text lives in native state;
 * `value` is pushed in only when it differs from what the field last
 * reported (a clear after sending), so typing never fights it.
 */
import {
  Column,
  OutlinedTextField,
  Text,
  useNativeState,
} from '@expo/ui/jetpack-compose';
import {
  fillMaxWidth,
  padding,
  semantics,
  testID as testIDMod,
  type ModifierConfig,
} from '@expo/ui/jetpack-compose/modifiers';
import { useEffect, useRef } from 'react';
import { useInForm } from './context';
import { ControlHost } from './host.android';
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
  const inForm = useInForm();
  const text = useNativeState(value);
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      text.set(value);
    }
  }, [value, text]);

  const mods: ModifierConfig[] = [fillMaxWidth()];
  const a11y = accessibilityLabel ?? placeholder;
  if (a11y) mods.push(semantics({ contentDescription: a11y }));
  if (testID) mods.push(testIDMod(testID));
  const action = onSubmit ? (submitLabel ?? 'done') : 'default';
  const submit = onSubmit ? () => onSubmit() : undefined;

  const field = (
    <OutlinedTextField
      value={text}
      singleLine={!multiline}
      minLines={multiline ? minLines : undefined}
      maxLines={multiline ? maxLines : undefined}
      enabled={!disabled}
      autoFocus={autoFocus}
      maxLength={maxLength}
      keyboardOptions={{
        capitalization: autoCapitalize ?? 'sentences',
        autoCorrectEnabled: autoCorrect ?? true,
        imeAction: action,
      }}
      keyboardActions={{
        onDone: submit,
        onGo: submit,
        onSend: submit,
        onSearch: submit,
        onNext: submit,
      }}
      onValueChange={(t) => {
        last.current = t;
        onChangeText(t);
      }}
      modifiers={mods}
    >
      {placeholder ? (
        <OutlinedTextField.Placeholder>
          <Text>{placeholder}</Text>
        </OutlinedTextField.Placeholder>
      ) : null}
    </OutlinedTextField>
  );
  return (
    <ControlHost style={style} width="fill">
      {inForm ? (
        <Column modifiers={[padding(16, 8, 16, 8)]}>{field}</Column>
      ) : (
        field
      )}
    </ControlHost>
  );
}
