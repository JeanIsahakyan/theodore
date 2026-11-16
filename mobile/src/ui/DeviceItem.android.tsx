/**
 * Android: a device as a Material 3 `ListItem` in the Devices `Form` card
 * (the kit's `Row` has no status dot or monospaced line):
 *
 * ```text
 * [icon]  Name ●                                ✓ Trusted
 *         Computer · macOS · online · runs spaces up to Edit
 *         Claude · Codex          (a computer's agents, if any)
 *         1a2b 3c4d … (monospace)
 * ```
 */
import {
  Box,
  Column,
  Icon,
  ListItem,
  Row,
  Text,
} from '@expo/ui/jetpack-compose';
import {
  Shapes,
  background,
  clip,
  padding,
  semantics,
  size as sizeMod,
} from '@expo/ui/jetpack-compose/modifiers';
import {
  fingerprintLabel,
  type DeviceItemProps,
  type FingerprintItemProps,
} from './deviceView';
import { kindIcon } from './native/icons';
import { MATERIAL } from './native/materialIcons';
import { usePalette } from './theme';

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
    <ListItem colors={{ containerColor: 'transparent' }}>
      <ListItem.LeadingContent>
        <Icon source={MATERIAL[kindIcon(kind)]} size={24} />
      </ListItem.LeadingContent>
      <ListItem.HeadlineContent>
        <Row verticalAlignment="center" horizontalArrangement={{ spacedBy: 8 }}>
          <Text color={p.text} maxLines={1} overflow="ellipsis">
            {name}
          </Text>
          <Box
            modifiers={[
              sizeMod(8, 8),
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
          {agents ? (
            <Text
              color={p.muted}
              style={{ typography: 'labelMedium' }}
              modifiers={[
                semantics({ contentDescription: `Agents: ${agents}` }),
              ]}
            >
              {agents}
            </Text>
          ) : null}
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
          <Row
            verticalAlignment="center"
            horizontalArrangement={{ spacedBy: 4 }}
          >
            <Icon source={MATERIAL.trusted} size={18} tint={p.success} />
            <Text color={p.success} style={{ typography: 'labelLarge' }}>
              Trusted
            </Text>
          </Row>
        </ListItem.TrailingContent>
      ) : null}
    </ListItem>
  );
}

export function FingerprintItem({
  value,
  label,
  size = 'regular',
}: FingerprintItemProps) {
  const p = usePalette();
  const text = (
    <Text
      color={p.text}
      style={{
        typography: size === 'large' ? 'titleMedium' : 'bodyMedium',
        fontFamily: 'monospace',
      }}
      modifiers={[semantics({ contentDescription: fingerprintLabel(value) })]}
    >
      {value || '—'}
    </Text>
  );
  if (!label) {
    return <Column modifiers={[padding(16, 16, 16, 16)]}>{text}</Column>;
  }
  return (
    <ListItem colors={{ containerColor: 'transparent' }}>
      <ListItem.LeadingContent>
        <Icon source={MATERIAL.fingerprint} size={24} />
      </ListItem.LeadingContent>
      <ListItem.HeadlineContent>
        <Text color={p.text}>{label}</Text>
      </ListItem.HeadlineContent>
      <ListItem.SupportingContent>{text}</ListItem.SupportingContent>
    </ListItem>
  );
}
