/**
 * Android: Material 3 exposed dropdown menu: a read-only outlined field
 * with the label, a menu of the choices under it.
 */
import {
  Column,
  DropdownMenuItem,
  ExposedDropdownMenu,
  ExposedDropdownMenuBox,
  OutlinedTextField,
  Text,
  useNativeState,
} from '@expo/ui/jetpack-compose';
import {
  fillMaxWidth,
  menuAnchor,
  padding,
  semantics,
  testID as testIDMod,
} from '@expo/ui/jetpack-compose/modifiers';
import { useEffect, useState } from 'react';
import { usePalette } from '../theme';
import { useInForm } from './context';
import { ControlHost } from './host.android';
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
  const [expanded, setExpanded] = useState(false);
  const shown = choices.find((c) => c.value === value)?.label ?? '';
  const text = useNativeState(shown);
  useEffect(() => {
    text.set(shown);
  }, [shown, text]);

  const box = (
    <ExposedDropdownMenuBox
      expanded={expanded}
      onExpandedChange={disabled ? undefined : setExpanded}
      modifiers={[fillMaxWidth()]}
    >
      <OutlinedTextField
        value={text}
        readOnly
        singleLine
        enabled={!disabled}
        modifiers={[
          menuAnchor(),
          fillMaxWidth(),
          semantics({ contentDescription: accessibilityLabel ?? label }),
          ...(testID ? [testIDMod(testID)] : []),
        ]}
      >
        <OutlinedTextField.Label>
          <Text>{label}</Text>
        </OutlinedTextField.Label>
        <OutlinedTextField.Placeholder>
          <Text>{placeholder}</Text>
        </OutlinedTextField.Placeholder>
        <OutlinedTextField.TrailingIcon>
          <Text color={p.muted}>{expanded ? '▴' : '▾'}</Text>
        </OutlinedTextField.TrailingIcon>
      </OutlinedTextField>
      <ExposedDropdownMenu
        expanded={expanded}
        onDismissRequest={() => setExpanded(false)}
      >
        {choices.map((c) => (
          <DropdownMenuItem
            key={c.value}
            onClick={() => {
              setExpanded(false);
              onChange(c.value);
            }}
            modifiers={
              c.accessibilityLabel
                ? [semantics({ contentDescription: c.accessibilityLabel })]
                : undefined
            }
          >
            <DropdownMenuItem.Text>
              <Text color={c.value === value ? p.accent : p.text}>
                {c.label}
              </Text>
            </DropdownMenuItem.Text>
          </DropdownMenuItem>
        ))}
      </ExposedDropdownMenu>
    </ExposedDropdownMenuBox>
  );
  return (
    <ControlHost style={style} width="fill">
      {inForm ? (
        <Column modifiers={[padding(16, 8, 16, 8)]}>{box}</Column>
      ) : (
        box
      )}
    </ControlHost>
  );
}
