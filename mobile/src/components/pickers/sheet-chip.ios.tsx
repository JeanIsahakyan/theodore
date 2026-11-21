/**
 * iOS: the chip is a small SwiftUI bordered capsule (the detail in the
 * secondary style, an optional SF Symbol before the label); it presents
 * the sheet's route, a formSheet with medium / large detents and a grabber
 * (`app/(app)/_layout.tsx`), Liquid Glass on iOS 26+.
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
import { SYMBOLS } from '../symbol-image';
import { useSheet } from './sheet-host';
import type { SheetChipProps } from './types';

export function SheetChip({
  sheet,
  space,
  icon,
  label,
  detail,
  accessibilityLabel,
  fixed,
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
      <Button
        // Fixed: the capsule stays, a tap does nothing.
        onPress={fixed ? undefined : open}
        modifiers={mods}
        testID={testID}
      >
        <HStack spacing={4}>
          {icon ? <Image systemName={SYMBOLS[icon].sf} size={12} /> : null}
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
          {fixed ? null : (
            <Image systemName="chevron.up.chevron.down" size={11} />
          )}
        </HStack>
      </Button>
    </ControlHost>
  );
}
