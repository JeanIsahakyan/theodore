/**
 * iOS: the chip is a SwiftUI bordered capsule (the Mode menu's look); it
 * presents the sheet's route, a formSheet with medium / large detents and
 * a grabber (`app/(app)/_layout.tsx`), Liquid Glass on iOS 26+.
 */
import { Button, HStack, Image, Text } from '@expo/ui/swift-ui';
import {
  accessibilityLabel as a11yLabel,
  buttonBorderShape,
  buttonStyle,
  disabled as disabledMod,
  lineLimit,
  type ModifierConfig,
} from '@expo/ui/swift-ui/modifiers';
import { router, type Href } from 'expo-router';
import { useRef } from 'react';
import { ControlHost } from '../../ui/native/host.ios';
import type { SheetChipProps } from './types';

export function sheetHref(
  sheet: SheetChipProps['sheet'],
  space?: string | null,
): Href {
  const path = sheet === 'model' ? '/model-picker' : '/where-picker';
  return (space ? `${path}?space=${encodeURIComponent(space)}` : path) as Href;
}

export function SheetChip({
  sheet,
  space,
  label,
  accessibilityLabel,
  disabled,
  testID,
}: SheetChipProps) {
  // One sheet per tap burst.
  const last = useRef(0);
  const mods: ModifierConfig[] = [
    buttonStyle('bordered'),
    buttonBorderShape('capsule'),
    a11yLabel(accessibilityLabel),
    ...(disabled ? [disabledMod(true)] : []),
  ];
  return (
    <ControlHost>
      <Button
        onPress={() => {
          const now = Date.now();
          if (now - last.current < 600) return;
          last.current = now;
          router.push(sheetHref(sheet, space));
        }}
        modifiers={mods}
        testID={testID}
      >
        <HStack spacing={4}>
          <Text modifiers={[lineLimit(1)]}>{label}</Text>
          <Image systemName="chevron.up.chevron.down" size={11} />
        </HStack>
      </Button>
    </ControlHost>
  );
}
