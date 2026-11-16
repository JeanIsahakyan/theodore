/**
 * iOS: a device as a SwiftUI row of the Devices `Form` (the kit's `Row`
 * has no status dot or monospaced line):
 *
 * ```text
 * [symbol] Name ●                         ✓ Trusted
 *          Computer · macOS · online · runs spaces up to Edit
 *          Claude · Codex                 (a computer's agents, if any)
 *          1a2b 3c4d … (monospaced, selectable)
 * ```
 */
import { HStack, Image, Label, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityHidden,
  accessibilityLabel,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  textSelection,
} from '@expo/ui/swift-ui/modifiers';
import {
  fingerprintLabel,
  type DeviceItemProps,
  type FingerprintItemProps,
} from './deviceView';
import { SF, kindIcon } from './native/icons';
import { usePalette } from './theme';

const secondary = foregroundStyle({ type: 'hierarchical', style: 'secondary' });

export function DeviceItem({
  name,
  kind,
  online,
  detail,
  fingerprint,
  trusted,
  agents,
}: DeviceItemProps) {
  const p = usePalette();
  return (
    <HStack alignment="top" spacing={12}>
      <Image
        systemName={SF[kindIcon(kind)]}
        color={p.accent}
        modifiers={[
          font({ textStyle: 'title3' }),
          frame({ width: 30 }),
          accessibilityHidden(true),
        ]}
      />
      <VStack alignment="leading" spacing={4}>
        <HStack spacing={8}>
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
              systemImage={SF.trusted}
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
        {agents ? (
          <Text
            modifiers={[
              font({ textStyle: 'caption' }),
              secondary,
              accessibilityLabel(`Agents: ${agents}`),
            ]}
          >
            {agents}
          </Text>
        ) : null}
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
    </HStack>
  );
}

export function FingerprintItem({
  value,
  label,
  size = 'regular',
}: FingerprintItemProps) {
  const text = (
    <Text
      modifiers={[
        font({
          textStyle: size === 'large' ? 'title3' : 'body',
          design: 'monospaced',
        }),
        textSelection(true),
        accessibilityLabel(fingerprintLabel(value)),
      ]}
    >
      {value || '—'}
    </Text>
  );
  if (!label) return text;
  return (
    <VStack alignment="leading" spacing={4}>
      <Label
        title={label}
        systemImage={SF.fingerprint}
        modifiers={[font({ textStyle: 'subheadline' }), secondary]}
      />
      {text}
    </VStack>
  );
}
