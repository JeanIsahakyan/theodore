/**
 * iOS: SwiftUI `Toggle` (a Settings row in a `Form`); `icon`: its label is
 * a `Label` with the SF Symbol, the detail under the title:
 *
 * ```text
 * Toggle { Label { VStack { label; detail (footnote, secondary) } } icon: symbol }
 * ```
 */
import { Label, Text, Toggle, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityLabel as a11yLabel,
  disabled as disabledMod,
  font,
  foregroundStyle,
} from '@expo/ui/swift-ui/modifiers';
import { ControlHost } from './host.ios';
import { SF } from './icons';
import type { SwitchProps } from './types';

export function Switch({
  label,
  detail,
  value,
  onValueChange,
  disabled,
  icon,
  accessibilityLabel,
  testID,
  style,
}: SwitchProps) {
  return (
    <ControlHost style={style} width="fill">
      <Toggle
        isOn={value}
        onIsOnChange={onValueChange}
        label={detail ? undefined : label}
        {...(icon && !detail ? { systemImage: SF[icon] } : {})}
        testID={testID}
        modifiers={[
          ...(disabled ? [disabledMod(true)] : []),
          a11yLabel(accessibilityLabel ?? label),
        ]}
      >
        {detail && icon ? (
          <Label systemImage={SF[icon]}>
            <VStack alignment="leading" spacing={2}>
              <Text>{label}</Text>
              <Text
                modifiers={[
                  font({ textStyle: 'footnote' }),
                  foregroundStyle({ type: 'hierarchical', style: 'secondary' }),
                ]}
              >
                {detail}
              </Text>
            </VStack>
          </Label>
        ) : detail ? (
          [<Text key="label">{label}</Text>, <Text key="detail">{detail}</Text>]
        ) : undefined}
      </Toggle>
    </ControlHost>
  );
}
