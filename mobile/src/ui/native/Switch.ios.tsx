/** iOS: SwiftUI `Toggle` (a Settings row in a `Form`). */
import { Text, Toggle } from '@expo/ui/swift-ui';
import {
  accessibilityLabel as a11yLabel,
  disabled as disabledMod,
} from '@expo/ui/swift-ui/modifiers';
import { ControlHost } from './host.ios';
import type { SwitchProps } from './types';

export function Switch({
  label,
  detail,
  value,
  onValueChange,
  disabled,
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
        testID={testID}
        modifiers={[
          ...(disabled ? [disabledMod(true)] : []),
          a11yLabel(accessibilityLabel ?? label),
        ]}
      >
        {detail
          ? [
              <Text key="label">{label}</Text>,
              <Text key="detail">{detail}</Text>,
            ]
          : undefined}
      </Toggle>
    </ControlHost>
  );
}
