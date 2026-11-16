/**
 * iOS: a device as a SwiftUI row of the Devices `Form` (the kit's `Row`
 * has no leading symbol, status dot or monospaced line):
 *
 * ```text
 * [symbol] Name ●                         ✓ Trusted
 *          Computer · macOS · online · runs spaces up to Edit
 *          1a2b 3c4d … (monospaced, selectable)
 * ```
 */
import { HStack, Image, Label, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityHidden,
  accessibilityLabel,
  font,
  foregroundStyle,
  lineLimit,
  textSelection,
} from '@expo/ui/swift-ui/modifiers';
import type { ComponentProps } from 'react';
import {
  fingerprintLabel,
  type DeviceItemProps,
  type FingerprintItemProps,
} from './deviceView';
import { usePalette } from './theme';

type Symbol = NonNullable<ComponentProps<typeof Image>['systemName']>;

const SYMBOL: Record<string, Symbol> = {
  desktop: 'desktopcomputer',
  daemon: 'server.rack',
  mobile: 'iphone',
  web: 'globe',
};

const secondary = foregroundStyle({ type: 'hierarchical', style: 'secondary' });

export function DeviceItem({
  name,
  kind,
  online,
  detail,
  fingerprint,
  trusted,
}: DeviceItemProps) {
  const p = usePalette();
  return (
    <VStack alignment="leading" spacing={6}>
      <HStack spacing={10}>
        <Image
          systemName={SYMBOL[kind] ?? 'questionmark.square.dashed'}
          color={p.accent}
          modifiers={[accessibilityHidden(true)]}
        />
        <Text modifiers={[font({ textStyle: 'headline' }), lineLimit(1)]}>
          {name}
        </Text>
        <Image
          systemName="circle.fill"
          size={8}
          color={online ? p.success : p.muted}
          modifiers={[accessibilityLabel(online ? 'Online' : 'Offline')]}
        />
        <Spacer />
        {trusted ? (
          <Label
            title="Trusted"
            systemImage="checkmark.seal.fill"
            modifiers={[
              font({ textStyle: 'subheadline' }),
              foregroundStyle(p.success),
            ]}
          />
        ) : null}
      </HStack>
      <Text modifiers={[font({ textStyle: 'footnote' }), secondary]}>
        {detail}
      </Text>
      <Text
        modifiers={[
          font({ textStyle: 'footnote', design: 'monospaced' }),
          textSelection(true),
          accessibilityLabel(fingerprintLabel(fingerprint)),
        ]}
      >
        {fingerprint || '—'}
      </Text>
    </VStack>
  );
}

export function FingerprintItem({ value }: FingerprintItemProps) {
  return (
    <Text
      modifiers={[
        font({ textStyle: 'title3', design: 'monospaced' }),
        textSelection(true),
        accessibilityLabel(fingerprintLabel(value)),
      ]}
    >
      {value || '—'}
    </Text>
  );
}
