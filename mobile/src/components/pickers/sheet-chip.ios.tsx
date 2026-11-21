/**
 * iOS: the chip is a small SwiftUI bordered capsule (the Mode menu's look,
 * the detail in the secondary style); it
 * presents the sheet's route, a formSheet with medium / large detents and
 * a grabber (`app/(app)/_layout.tsx`), Liquid Glass on iOS 26+.
 */
import { Button, HStack, Image, Text } from '@expo/ui/swift-ui';
import {
  accessibilityLabel as a11yLabel,
  buttonBorderShape,
  buttonStyle,
  controlSize,
  foregroundStyle,
  disabled as disabledMod,
  lineLimit,
  type ModifierConfig,
} from '@expo/ui/swift-ui/modifiers';
import { ControlHost } from '../../ui/native/host.ios';
import { useSheet } from './sheet-host';
import type { SheetChipProps } from './types';

export function SheetChip({
  sheet,
  space,
  label,
  detail,
  accessibilityLabel,
  disabled,
  testID,
}: SheetChipProps) {
  const { open } = useSheet(sheet, space);
  const mods: ModifierConfig[] = [
    buttonStyle('bordered'),
    buttonBorderShape('capsule'),
    controlSize('small'),
    a11yLabel(accessibilityLabel),
    ...(disabled ? [disabledMod(true)] : []),
  ];
  return (
    <ControlHost>
      <Button onPress={open} modifiers={mods} testID={testID}>
        <HStack spacing={4}>
          <Text modifiers={[lineLimit(1)]}>{label}</Text>
          {detail ? (
            <Text
              modifiers={[
                lineLimit(1),
                foregroundStyle({ type: 'hierarchical', style: 'secondary' }),
              ]}
            >
              {detail}
            </Text>
          ) : null}
          <Image systemName="chevron.up.chevron.down" size={11} />
        </HStack>
      </Button>
    </ControlHost>
  );
}
