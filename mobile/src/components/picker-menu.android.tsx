// Adapted from EvanBacon/chat-template (MIT)
/**
 * Android: the composer's picker (the template's model picker) as
 * Material 3: an assist chip that opens a modal bottom sheet. Each group
 * a heading and a radio list; a pick stays in the sheet when it has
 * several groups (pick the agent, then its model), and closes it when it
 * has one. Swipe down, the scrim or Back close it.
 *
 * ```text
 * ( Opus 4.1 · High ▾ ) ─▶ ━━━━
 *                          Agent
 *                          ◉ Claude   ○ Codex
 *                          Model
 *                          ◉ Default (Opus 4.1)  ○ Sonnet 4.5 …
 * ```
 */
import {
  AssistChip,
  Column,
  ModalBottomSheet,
  RadioButton,
  Row,
  Text,
} from '@expo/ui/jetpack-compose';
import {
  fillMaxWidth,
  padding,
  selectable,
  selectableGroup,
  semantics,
  testID as testIDMod,
  verticalScroll,
  type ModifierConfig,
} from '@expo/ui/jetpack-compose/modifiers';
import { Fragment, useState } from 'react';
import { ControlHost } from '../ui/native/host.android';
import type { MenuProps } from '../ui/native/types';
import { usePalette } from '../ui/theme';

export function PickerMenu({
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
      <AssistChip
        // Remounted when it turns on or off (Compose keeps the first handler).
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
      {open ? (
        <ModalBottomSheet onDismissRequest={() => setOpen(false)}>
          <Column
            modifiers={[fillMaxWidth(), verticalScroll(), padding(0, 0, 0, 24)]}
          >
            {groups.map((g) => (
              <Fragment key={g.label}>
                <Text
                  color={p.accent}
                  style={{ typography: 'titleSmall' }}
                  modifiers={[padding(24, 16, 24, 8)]}
                >
                  {g.label}
                </Text>
                <Column modifiers={[fillMaxWidth(), selectableGroup()]}>
                  {g.choices.map((c) => {
                    const on = c.value === g.value;
                    const pick = () => {
                      if (groups.length === 1) setOpen(false);
                      if (!on) g.onChange(c.value);
                    };
                    return (
                      <Row
                        key={c.value}
                        verticalAlignment="center"
                        horizontalArrangement={{ spacedBy: 16 }}
                        modifiers={[
                          fillMaxWidth(),
                          selectable(on, pick, 'radioButton'),
                          padding(24, 12, 24, 12),
                          ...(c.accessibilityLabel
                            ? [
                                semantics({
                                  contentDescription: c.accessibilityLabel,
                                }),
                              ]
                            : []),
                        ]}
                      >
                        <RadioButton selected={on} />
                        <Text
                          color={p.text}
                          style={{ typography: 'bodyLarge' }}
                          maxLines={1}
                        >
                          {c.label}
                        </Text>
                      </Row>
                    );
                  })}
                </Column>
              </Fragment>
            ))}
          </Column>
        </ModalBottomSheet>
      ) : null}
    </ControlHost>
  );
}
