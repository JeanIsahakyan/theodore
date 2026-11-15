/**
 * Android: the kit's Material 3 `OutlinedTextField` with a ref (`focus()`)
 * and `onFocus` (see `chatFieldTypes.ts`). The text lives in native state;
 * `value` is pushed in only when it differs from what the field last
 * reported (cleared after sending).
 */
import {
  OutlinedTextField,
  Text,
  useNativeState,
  type TextFieldRef,
} from '@expo/ui/jetpack-compose';
import {
  fillMaxWidth,
  semantics,
  testID as testIDMod,
  type ModifierConfig,
} from '@expo/ui/jetpack-compose/modifiers';
import { useEffect, useImperativeHandle, useRef } from 'react';
import type { ChatFieldProps } from './chatFieldTypes';
import { ControlHost } from './native/host.android';

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
  const field = useRef<TextFieldRef>(null);
  const text = useNativeState(value);
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      text.set(value);
    }
  }, [value, text]);
  useImperativeHandle(
    ref,
    () => ({ focus: () => void field.current?.focus() }),
    [],
  );

  const mods: ModifierConfig[] = [fillMaxWidth()];
  const a11y = accessibilityLabel ?? placeholder;
  if (a11y) mods.push(semantics({ contentDescription: a11y }));
  if (testID) mods.push(testIDMod(testID));
  const action = onSubmit ? (submitLabel ?? 'done') : 'default';
  const submit = onSubmit ? () => onSubmit() : undefined;

  return (
    <ControlHost style={style} width="fill">
      <OutlinedTextField
        ref={field}
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
        onFocusChanged={(focused) => {
          if (focused) onFocus?.();
        }}
        modifiers={mods}
      >
        {placeholder ? (
          <OutlinedTextField.Placeholder>
            <Text>{placeholder}</Text>
          </OutlinedTextField.Placeholder>
        ) : null}
      </OutlinedTextField>
    </ControlHost>
  );
}
