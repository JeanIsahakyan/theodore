/**
 * iOS: SwiftUI `TextField` (vertical axis when multiline). The text lives
 * in native state; `value` is pushed in only when it differs from what the
 * field last reported (a clear after sending), so typing never fights it.
 * `glass` (standalone): on Liquid Glass (iOS 26+) instead of a card fill.
 */
import { TextField as STextField, useNativeState } from '@expo/ui/swift-ui';
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
import { useEffect, useRef } from 'react';
import { usePalette } from '../theme';
import { useInForm } from './context';
import { ControlHost, glassBehind } from './host.ios';
import { liquidGlass } from './liquidGlass';
import type { TextFieldProps } from './types';

const caps = { none: 'never', sentences: 'sentences', words: 'words' } as const;

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
  glass,
  accessibilityLabel,
  testID,
  style,
}: TextFieldProps) {
  const p = usePalette();
  const inForm = useInForm();
  const text = useNativeState(value);
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      text.set(value);
    }
  }, [value, text]);

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
  if (!inForm && glass && liquidGlass) {
    mods.push(
      padding({ horizontal: 14, vertical: 10 }),
      ...glassBehind('rounded', { radius: 20, interactive: true }),
    );
  } else if (!inForm) {
    mods.push(
      padding({ horizontal: 12, vertical: 10 }),
      background(p.surface),
      cornerRadius(12),
    );
  }
  return (
    <ControlHost style={style} width="fill">
      <STextField
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
        modifiers={mods}
      />
    </ControlHost>
  );
}
