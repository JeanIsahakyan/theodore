/**
 * Android: a Material 3 `AssistChip` that opens a `DropdownMenu` anchored
 * to it: each group a heading, its choices under it (a check on the
 * chosen one), dividers between the groups.
 *
 * ```text
 * ( Opus 4.1 · High ▾ ) ─▶ Agent   Claude ✓  Codex
 *                          ───────
 *                          Model   Opus 4.1 ✓  Sonnet 4.5 …
 * ```
 */
import {
  AssistChip,
  DropdownMenu,
  DropdownMenuItem,
  HorizontalDivider,
  Text,
} from '@expo/ui/jetpack-compose';
import {
  padding,
  semantics,
  testID as testIDMod,
  type ModifierConfig,
} from '@expo/ui/jetpack-compose/modifiers';
import { Fragment, useState } from 'react';
import { usePalette } from '../theme';
import { ControlHost } from './host.android';
import type { MenuProps } from './types';

export function Menu({
  label,
  groups,
  disabled,
  accessibilityLabel,
  testID,
  style,
}: MenuProps) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  const mods: ModifierConfig[] = [
    semantics({ contentDescription: accessibilityLabel ?? label }),
    ...(testID ? [testIDMod(testID)] : []),
  ];
  return (
    <ControlHost style={style}>
      <DropdownMenu expanded={open} onDismissRequest={() => setOpen(false)}>
        <DropdownMenu.Trigger>
          <AssistChip
            // Remounted when it turns on or off (Compose keeps the click
            // handler it was mounted with).
            key={disabled ? 'off' : 'on'}
            enabled={!disabled}
            onClick={disabled ? undefined : () => setOpen(true)}
            modifiers={mods}
          >
            <AssistChip.Label>
              <Text maxLines={1}>{label}</Text>
            </AssistChip.Label>
            <AssistChip.TrailingIcon>
              <Text>▾</Text>
            </AssistChip.TrailingIcon>
          </AssistChip>
        </DropdownMenu.Trigger>
        <DropdownMenu.Items>
          {groups.map((g, i) => (
            <Fragment key={g.label}>
              {i > 0 ? (
                <HorizontalDivider modifiers={[padding(0, 4, 0, 4)]} />
              ) : null}
              <Text
                color={p.muted}
                style={{ typography: 'labelMedium' }}
                modifiers={[padding(16, 8, 16, 4)]}
              >
                {g.label}
              </Text>
              {g.choices.map((c) => (
                <DropdownMenuItem
                  key={c.value}
                  onClick={() => {
                    setOpen(false);
                    if (c.value !== g.value) g.onChange(c.value);
                  }}
                  modifiers={
                    c.accessibilityLabel
                      ? [
                          semantics({
                            contentDescription: c.accessibilityLabel,
                          }),
                        ]
                      : undefined
                  }
                >
                  <DropdownMenuItem.Text>
                    <Text color={c.value === g.value ? p.accent : p.text}>
                      {c.label}
                    </Text>
                  </DropdownMenuItem.Text>
                  {c.value === g.value ? (
                    <DropdownMenuItem.TrailingIcon>
                      <Text color={p.accent}>✓</Text>
                    </DropdownMenuItem.TrailingIcon>
                  ) : null}
                </DropdownMenuItem>
              ))}
            </Fragment>
          ))}
        </DropdownMenu.Items>
      </DropdownMenu>
    </ControlHost>
  );
}
