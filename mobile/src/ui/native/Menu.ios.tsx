/**
 * iOS: a SwiftUI `Menu` styled as a button: `.glass` with `glass` on iOS
 * 26+, a `.bordered` capsule otherwise (SwiftUI's own fallback below 26 is
 * a bare label). Each group is a `.menu` `Picker`: a submenu titled with
 * the group, showing its choice, with a checkmark on it.
 *
 * ```text
 * ( Opus 4.1 · High ⌃⌄ ) ─▶ Agent  ›  Claude
 *                           Model  ›  Opus 4.1
 *                           Effort ›  High
 * ```
 */
import { HStack, Image, Menu as SMenu, Picker, Text } from '@expo/ui/swift-ui';
import {
  accessibilityLabel as a11yLabel,
  buttonBorderShape,
  buttonStyle,
  disabled as disabledMod,
  lineLimit,
  menuStyle,
  pickerStyle,
  tag,
  type ModifierConfig,
} from '@expo/ui/swift-ui/modifiers';
import { ControlHost } from './host.ios';
import { liquidGlass } from './liquidGlass';
import type { MenuProps } from './types';

/** The tag of the row shown while a group has nothing chosen. */
const NONE = '\u0000none';

export function Menu({
  label,
  groups,
  disabled,
  glass,
  accessibilityLabel,
  testID,
  style,
}: MenuProps) {
  const mods: ModifierConfig[] = [
    menuStyle('button'),
    buttonStyle(glass && liquidGlass ? 'glass' : 'bordered'),
    buttonBorderShape('capsule'),
    a11yLabel(accessibilityLabel ?? label),
    ...(disabled ? [disabledMod(true)] : []),
  ];
  return (
    <ControlHost style={style}>
      <SMenu
        label={
          <HStack spacing={4}>
            <Text modifiers={[lineLimit(1)]}>{label}</Text>
            <Image systemName="chevron.up.chevron.down" size={11} />
          </HStack>
        }
        modifiers={mods}
        testID={testID}
      >
        {groups.map((g) => (
          <Picker<string>
            key={g.label}
            label={g.label}
            selection={g.value ?? NONE}
            onSelectionChange={(v) => {
              const c = g.choices.find((x) => x.value === v);
              if (c) g.onChange(c.value);
            }}
            modifiers={[pickerStyle('menu')]}
          >
            {g.value == null ? <Text modifiers={[tag(NONE)]}>—</Text> : null}
            {g.choices.map((c) => (
              <Text
                key={c.value}
                modifiers={[
                  tag(c.value),
                  ...(c.accessibilityLabel
                    ? [a11yLabel(c.accessibilityLabel)]
                    : []),
                ]}
              >
                {c.label}
              </Text>
            ))}
          </Picker>
        ))}
      </SMenu>
    </ControlHost>
  );
}
