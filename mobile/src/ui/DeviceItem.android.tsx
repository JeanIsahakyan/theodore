/**
 * Android: a device as a Material 3 `ListItem` in the Devices `Form` card
 * (the kit's `Row` has no status dot or monospaced line):
 *
 * ```text
 * Name ●                                   ✓ Trusted
 * Computer · macOS · online · runs spaces up to Edit
 * 1a2b 3c4d … (monospace)
 * ```
 */
import { Box, Column, ListItem, Row, Text } from '@expo/ui/jetpack-compose';
import {
  Shapes,
  background,
  clip,
  paddingAll,
  semantics,
  size,
} from '@expo/ui/jetpack-compose/modifiers';
import {
  fingerprintLabel,
  type DeviceItemProps,
  type FingerprintItemProps,
} from './deviceView';
import { usePalette } from './theme';

export function DeviceItem({
  name,
  online,
  detail,
  fingerprint,
  trusted,
}: DeviceItemProps) {
  const p = usePalette();
  return (
    <ListItem colors={{ containerColor: 'transparent' }}>
      <ListItem.HeadlineContent>
        <Row verticalAlignment="center" horizontalArrangement={{ spacedBy: 8 }}>
          <Text color={p.text} maxLines={1} overflow="ellipsis">
            {name}
          </Text>
          <Box
            modifiers={[
              size(8, 8),
              clip(Shapes.Circle),
              background(online ? p.success : p.muted),
              semantics({ contentDescription: online ? 'Online' : 'Offline' }),
            ]}
          />
        </Row>
      </ListItem.HeadlineContent>
      <ListItem.SupportingContent>
        <Column verticalArrangement={{ spacedBy: 4 }}>
          <Text color={p.muted}>{detail}</Text>
          <Text
            color={p.text}
            style={{ typography: 'bodySmall', fontFamily: 'monospace' }}
            modifiers={[
              semantics({ contentDescription: fingerprintLabel(fingerprint) }),
            ]}
          >
            {fingerprint || '—'}
          </Text>
        </Column>
      </ListItem.SupportingContent>
      {trusted ? (
        <ListItem.TrailingContent>
          <Text color={p.success} style={{ typography: 'labelLarge' }}>
            ✓ Trusted
          </Text>
        </ListItem.TrailingContent>
      ) : null}
    </ListItem>
  );
}

export function FingerprintItem({ value }: FingerprintItemProps) {
  const p = usePalette();
  return (
    <Text
      color={p.text}
      style={{ typography: 'titleMedium', fontFamily: 'monospace' }}
      modifiers={[
        paddingAll(16),
        semantics({ contentDescription: fingerprintLabel(value) }),
      ]}
    >
      {value || '—'}
    </Text>
  );
}
