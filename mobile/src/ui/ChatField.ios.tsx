/**
 * iOS: the kit's SwiftUI `TextField` with a ref (`focus()`) and `onFocus`
 * (see `chatFieldTypes.ts`). Filled with the screen's background, so it
 * reads on the composer bar and on a card; `glass`: on Liquid Glass (iOS
 * 26+), the floating composer's field. The text lives in native state;
 * `value` is pushed in only when it differs from what the field last
 * reported (cleared after sending).
 */
import {
  TextField as STextField,
  useNativeState,
  type TextFieldRef,
} from '@expo/ui/swift-ui';
import {
  accessibilityLabel as a11yLabel,
  autocorrectionDisabled,
  background,
  cornerRadius,
  disabled as disabledMod,
  lineLimit,
  onSubmit as onSubmitMod,
  padding,
  submitLabel as submitLabelMod,
  textInputAutocapitalization,
  type ModifierConfig,
} from '@expo/ui/swift-ui/modifiers';
import { useEffect, useImperativeHandle, useRef } from 'react';
import type { ChatFieldProps } from './chatFieldTypes';
import { ControlHost, glassBehind } from './native/host.ios';
import { liquidGlass } from './native/liquidGlass';
import { usePalette } from './theme';

const caps = { none: 'never', sentences: 'sentences', words: 'words' } as const;

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
  glass,
  accessibilityLabel,
  testID,
  style,
}: ChatFieldProps) {
  const p = usePalette();
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

  const mods: ModifierConfig[] = [];
  if (multiline) mods.push(lineLimit({ min: minLines, max: maxLines }));
  if (onSubmit) mods.push(onSubmitMod(onSubmit));
  if (submitLabel) mods.push(submitLabelMod(submitLabel));
  if (autoCapitalize)
    mods.push(textInputAutocapitalization(caps[autoCapitalize]));
  if (autoCorrect === false) mods.push(autocorrectionDisabled(true));
  if (disabled) mods.push(disabledMod(true));
  const a11y = accessibilityLabel ?? placeholder;
  if (a11y) mods.push(a11yLabel(a11y));
  mods.push(padding({ horizontal: 14, vertical: 10 }));
  if (glass && liquidGlass) {
    mods.push(...glassBehind('rounded', { radius: 20, interactive: true }));
  } else {
    mods.push(background(p.background), cornerRadius(20));
  }
  return (
    <ControlHost style={style} width="fill">
      <STextField
        ref={field}
        text={text}
        placeholder={placeholder}
        axis={multiline ? 'vertical' : 'horizontal'}
        autoFocus={autoFocus}
        maxLength={maxLength}
        testID={testID}
        onTextChange={(t) => {
          last.current = t;
          onChangeText(t);
        }}
        onFocusChange={(focused) => {
          if (focused) onFocus?.();
        }}
        modifiers={mods}
      />
    </ControlHost>
  );
}
