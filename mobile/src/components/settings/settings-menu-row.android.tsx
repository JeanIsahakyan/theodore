/**
 * Android: a Material 3 list item ("Appearance / System") anchoring a
 * `DropdownMenu` of the choices, a check on the current one. Its metrics
 * match `SettingsRow` (16 dp sides, 24 dp icon, the value as supporting
 * text).
 *
 * ```text
 * [◐]  Appearance          ─▶   Light
 *      System                   Dark
 *                               System  ✓
 * ```
 */
import {
  DropdownMenu,
  DropdownMenuItem,
  Host,
  Icon,
  ListItem,
  Text,
} from '@expo/ui/jetpack-compose';
import {
  clickable,
  fillMaxWidth,
  semantics,
  testID as testIDMod,
} from '@expo/ui/jetpack-compose/modifiers';
import { useState } from 'react';
import { useHostTheme } from '../../ui/native/host.android';
import { MATERIAL } from '../../ui/native/materialIcons';
import { usePalette } from '../../ui/theme';
import { tick } from './feedback';
import { KIT_ICON, type SettingsMenuRowProps } from './types';

export function SettingsMenuRow<T extends string>({
  icon,
  label,
  choices,
  value,
  onChange,
  testID,
}: SettingsMenuRowProps<T>) {
  const p = usePalette();
  const theme = useHostTheme();
  const [open, setOpen] = useState(false);
  const shown = choices.find((c) => c.value === value)?.label ?? '';
  const kitIcon = KIT_ICON[icon];
  return (
    <Host
      {...theme}
      matchContents={{ vertical: true }}
      style={{ width: '100%' }}
    >
      <DropdownMenu
        expanded={open}
        onDismissRequest={() => setOpen(false)}
        modifiers={[fillMaxWidth()]}
      >
        <DropdownMenu.Trigger>
          <ListItem
            colors={{ containerColor: 'transparent' }}
            modifiers={[
              fillMaxWidth(),
              clickable(() => setOpen(true)),
              semantics({ contentDescription: `${label}, ${shown}` }),
              ...(testID ? [testIDMod(testID)] : []),
            ]}
          >
            {kitIcon ? (
              <ListItem.LeadingContent>
                <Icon source={MATERIAL[kitIcon]} size={24} tint={p.muted} />
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
                if (c.value === value) return;
                tick();
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
              {c.value === value ? (
                <DropdownMenuItem.TrailingIcon>
                  <Text color={p.accent}>✓</Text>
                </DropdownMenuItem.TrailingIcon>
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenu.Items>
      </DropdownMenu>
    </Host>
  );
}
