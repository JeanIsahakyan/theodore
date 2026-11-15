/**
 * iOS: a capsule SwiftUI `Button`, `.borderedProminent` when picked,
 * `.bordered` otherwise, with the selected trait for VoiceOver. A button
 * rather than a `Toggle`: the answer's rules (`pickOption`) decide what is
 * picked, and a toggle would flip itself first.
 */
import { Button, Text } from '@expo/ui/swift-ui';
import {
  accessibilityAddTraits,
  accessibilityLabel as a11yLabel,
  buttonBorderShape,
  buttonStyle,
  disabled as disabledMod,
  type ModifierConfig,
} from '@expo/ui/swift-ui/modifiers';
import { ControlHost } from './native/host.ios';
import type { OptionChipProps } from './optionChipTypes';

export function OptionChip({
  label,
  selected,
  onPress,
  disabled,
  accessibilityLabel,
}: OptionChipProps) {
  const mods: ModifierConfig[] = [
    buttonStyle(selected ? 'borderedProminent' : 'bordered'),
    buttonBorderShape('capsule'),
    a11yLabel(accessibilityLabel ?? label),
  ];
  if (selected) mods.push(accessibilityAddTraits(['isSelected']));
  if (disabled) mods.push(disabledMod(true));
  return (
    <ControlHost>
      <Button onPress={onPress} modifiers={mods}>
        <Text>{label}</Text>
      </Button>
    </ControlHost>
  );
}
