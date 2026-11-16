/**
 * Android: standalone, a Material 3 exposed dropdown menu (a read-only
 * outlined field with the label, a menu of the choices under it). In a
 * `Form`, a settings list item that opens a menu of the choices:
 *
 * ```text
 * [icon]  Theme                     ─▶   Light
 *         System                         Dark
 *                                        System  ✓
 * ```
 */
import {
  DropdownMenu,
  DropdownMenuItem,
  ExposedDropdownMenu,
  ExposedDropdownMenuBox,
  Icon,
  ListItem,
  OutlinedTextField,
  Text,
  useNativeState,
} from '@expo/ui/jetpack-compose';
import {
  alpha,
  clickable,
  fillMaxWidth,
  menuAnchor,
  semantics,
  testID as testIDMod,
  type ModifierConfig,
} from '@expo/ui/jetpack-compose/modifiers';
import { useEffect, useState } from 'react';
import { usePalette } from '../theme';
import { useInForm } from './context';
import { ControlHost } from './host.android';
import { MATERIAL } from './materialIcons';
import type { SelectProps } from './types';

export function Select<T extends string>({
  label,
  choices,
  value,
  onChange,
  placeholder = 'Choose…',
  disabled,
  icon,
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
  if (inForm) {
    return (
      <SettingsSelect
        label={label}
        choices={choices}
        value={value}
        onChange={onChange}
        shown={shown || placeholder}
        disabled={disabled}
        icon={icon}
        accessibilityLabel={accessibilityLabel}
        testID={testID}
      />
    );
  }
  return (
    <ControlHost style={style} width="fill">
      {box}
    </ControlHost>
  );
}

/** In a `Form`: a list item ("Theme / System") anchoring a dropdown menu. */
function SettingsSelect<T extends string>({
  label,
  choices,
  value,
  onChange,
  shown,
  disabled,
  icon,
  accessibilityLabel,
  testID,
}: Pick<
  SelectProps<T>,
  | 'label'
  | 'choices'
  | 'value'
  | 'onChange'
  | 'disabled'
  | 'icon'
  | 'accessibilityLabel'
  | 'testID'
> & { shown: string }) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  const mods: ModifierConfig[] = [
    fillMaxWidth(),
    ...(disabled ? [alpha(0.38)] : [clickable(() => setOpen(true))]),
    semantics({
      contentDescription: `${accessibilityLabel ?? label}, ${shown}`,
    }),
    ...(testID ? [testIDMod(testID)] : []),
  ];
  return (
    <DropdownMenu
      expanded={open}
      onDismissRequest={() => setOpen(false)}
      modifiers={[fillMaxWidth()]}
    >
      <DropdownMenu.Trigger>
        <ListItem
          // Remounted when it turns on or off: Compose keeps the click
          // handler it was mounted with.
          key={disabled ? 'off' : 'on'}
          colors={{ containerColor: 'transparent' }}
          modifiers={mods}
        >
          {icon ? (
            <ListItem.LeadingContent>
              <Icon source={MATERIAL[icon]} size={24} />
            </ListItem.LeadingContent>
          ) : null}
          <ListItem.HeadlineContent>
            <Text color={p.text}>{label}</Text>
          </ListItem.HeadlineContent>
          <ListItem.SupportingContent>
            <Text color={p.muted}>{shown}</Text>
          </ListItem.SupportingContent>
        </ListItem>
      </DropdownMenu.Trigger>
      <DropdownMenu.Items>
        {choices.map((c) => (
          <DropdownMenuItem
            key={c.value}
            onClick={() => {
              setOpen(false);
              if (c.value !== value) onChange(c.value);
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
            {c.value === value ? (
              <DropdownMenuItem.TrailingIcon>
                <Text color={p.accent}>✓</Text>
              </DropdownMenuItem.TrailingIcon>
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenu.Items>
    </DropdownMenu>
  );
}
