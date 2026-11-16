/**
 * iOS: SwiftUI `Picker` with `.segmented` style; `glass`: on a Liquid Glass
 * capsule (iOS 26+).
 */
import { Picker, Text } from '@expo/ui/swift-ui';
import {
  accessibilityLabel as a11yLabel,
  disabled as disabledMod,
  pickerStyle,
  tag,
} from '@expo/ui/swift-ui/modifiers';
import { ControlHost, glassBehind } from './host.ios';
import type { SegmentedProps } from './types';

export function Segmented<T extends string>({
  label,
  choices,
  value,
  onChange,
  disabled,
  glass,
  accessibilityLabel,
  testID,
  style,
}: SegmentedProps<T>) {
  return (
    <ControlHost style={style} width="fill">
      <Picker<string>
        label={label}
        selection={value}
        onSelectionChange={(v) => {
          const c = choices.find((x) => x.value === v);
          if (c) onChange(c.value);
        }}
        testID={testID}
        modifiers={[
          pickerStyle('segmented'),
          a11yLabel(accessibilityLabel ?? label),
          ...(disabled ? [disabledMod(true)] : []),
          ...(glass ? glassBehind('capsule', { inset: 4 }) : []),
        ]}
      >
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
