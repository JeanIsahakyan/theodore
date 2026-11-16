/**
 * Android: Compose pieces of the picker sheets, Material 3: a `titleLarge`
 * title, `titleSmall` headings in the primary color, `ListItem` rows with a
 * trailing check, dividers between groups.
 */
import {
  Box,
  HorizontalDivider,
  Icon,
  ListItem,
  Row,
  Text,
} from '@expo/ui/jetpack-compose';
import {
  Shapes,
  alpha,
  background,
  clickable,
  clip,
  padding,
  semantics,
  size,
  testID as testIDMod,
  type ModifierConfig,
} from '@expo/ui/jetpack-compose/modifiers';
import type { ReactNode } from 'react';
import { usePalette } from '../../ui/theme';

const CHECK = require('../../../assets/icons/check.xml');
const CHEVRON = require('../../../assets/icons/chevron_right.xml');

export function SheetTitle({
  children,
  leading,
}: {
  children: string;
  leading?: ReactNode;
}) {
  const p = usePalette();
  return (
    <Row
      verticalAlignment="center"
      horizontalArrangement={{ spacedBy: 8 }}
      modifiers={[padding(leading ? 12 : 24, 0, 24, 8)]}
    >
      {leading}
      <Text color={p.text} style={{ typography: 'titleLarge' }} maxLines={1}>
        {children}
      </Text>
    </Row>
  );
}

export function SheetHeading({ children }: { children: string }) {
  const p = usePalette();
  return (
    <Text
      color={p.accent}
      style={{ typography: 'titleSmall' }}
      modifiers={[padding(24, 16, 24, 4)]}
    >
      {children}
    </Text>
  );
}

export function SheetDivider() {
  return <HorizontalDivider modifiers={[padding(24, 8, 24, 8)]} />;
}

export function SheetRow({
  label,
  detail,
  selected,
  onPress,
  disabled,
  accent,
  dot,
  chevron,
  accessibilityLabel,
  testID,
}: {
  label: string;
  detail?: string | null;
  selected?: boolean;
  onPress: () => void;
  disabled?: boolean;
  accent?: boolean;
  dot?: 'on' | 'off';
  chevron?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}) {
  const p = usePalette();
  const mods: ModifierConfig[] = [
    ...(disabled ? [alpha(0.38)] : [clickable(onPress)]),
    ...(accessibilityLabel
      ? [semantics({ contentDescription: accessibilityLabel })]
      : []),
    ...(testID ? [testIDMod(testID)] : []),
  ];
  return (
    <ListItem
      // Remounted when it turns on or off: Compose keeps the click handler
      // it was mounted with.
      key={disabled ? 'off' : 'on'}
      colors={{ containerColor: 'transparent' }}
      modifiers={[padding(8, 0, 8, 0), ...mods]}
    >
      {dot ? (
        <ListItem.LeadingContent>
          <Box
            modifiers={[
              size(10, 10),
              clip(Shapes.Circle),
              background(dot === 'on' ? p.success : p.muted),
            ]}
          />
        </ListItem.LeadingContent>
      ) : null}
      <ListItem.HeadlineContent>
        <Text color={accent ? p.accent : p.text} maxLines={1}>
          {label}
        </Text>
      </ListItem.HeadlineContent>
      {detail ? (
        <ListItem.SupportingContent>
          <Text color={p.muted} maxLines={1}>
            {detail}
          </Text>
        </ListItem.SupportingContent>
      ) : null}
      {selected || chevron ? (
        <ListItem.TrailingContent>
          <Row verticalAlignment="center">
            {selected ? (
              <Icon source={CHECK} size={22} tint={p.accent} />
            ) : null}
            {chevron ? (
              <Icon source={CHEVRON} size={22} tint={p.muted} />
            ) : null}
          </Row>
        </ListItem.TrailingContent>
      ) : null}
    </ListItem>
  );
}
