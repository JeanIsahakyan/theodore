/**
 * iOS: SwiftUI `Picker` with `.menu` style: in a `Form` the Settings row
 * "Label   Value ⌃⌄", standalone a button showing the choice; `glass`: on a
 * Liquid Glass capsule (iOS 26+).
 */
import { Picker, Text } from '@expo/ui/swift-ui';
import {
  accessibilityLabel as a11yLabel,
  disabled as disabledMod,
  pickerStyle,
  tag,
} from '@expo/ui/swift-ui/modifiers';
import { ControlHost, glassBehind } from './host.ios';
import type { SelectProps } from './types';

/** The tag of the placeholder shown while nothing is chosen. */
const NONE = '\u0000none';

export function Select<T extends string>({
  label,
  choices,
  value,
  onChange,
  placeholder = 'Choose…',
  disabled,
  glass,
  accessibilityLabel,
  testID,
  style,
}: SelectProps<T>) {
  return (
    <ControlHost style={style}>
      <Picker<string>
        label={label}
        selection={value ?? NONE}
        onSelectionChange={(v) => {
          const c = choices.find((x) => x.value === v);
          if (c) onChange(c.value);
        }}
        testID={testID}
        modifiers={[
          pickerStyle('menu'),
          a11yLabel(accessibilityLabel ?? label),
          ...(disabled ? [disabledMod(true)] : []),
          ...(glass
            ? glassBehind('capsule', { inset: 4, interactive: true })
            : []),
        ]}
      >
        {value == null ? (
          <Text modifiers={[tag(NONE)]}>{placeholder}</Text>
        ) : null}
        {choices.map((c) => (
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
    </ControlHost>
  );
}
