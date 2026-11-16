/**
 * Android: Material 3 buttons. primary ─▶ `Button` (filled), secondary ─▶
 * `FilledTonalButton`, plain ─▶ `TextButton`, destructive ─▶ filled in the
 * danger color. In a `Form`: a clickable `ListItem` (accent, or danger).
 */
import {
  Button as FilledButton,
  CircularProgressIndicator,
  FilledTonalButton,
  ListItem,
  Row,
  Text,
  TextButton,
} from '@expo/ui/jetpack-compose';
import {
  alpha,
  clickable,
  fillMaxWidth,
  semantics,
  size,
  testID as testIDMod,
  type ModifierConfig,
} from '@expo/ui/jetpack-compose/modifiers';
import { usePalette } from '../theme';
import { useInForm } from './context';
import { ControlHost } from './host.android';
import type { ButtonProps } from './types';

export function Button({
  label,
  onPress,
  variant = 'secondary',
  disabled,
  loading,
  fullWidth,
  accessibilityLabel,
  testID,
  style,
}: ButtonProps) {
  const p = usePalette();
  const inForm = useInForm();
  const off = !!disabled || !!loading;
  const mods: ModifierConfig[] = [];
  if (accessibilityLabel)
    mods.push(semantics({ contentDescription: accessibilityLabel }));
  if (testID) mods.push(testIDMod(testID));

  if (inForm) {
    const color = variant === 'destructive' ? p.danger : p.accent;
    return (
      <ListItem
        colors={{ containerColor: 'transparent' }}
        modifiers={[...(off ? [alpha(0.38)] : [clickable(onPress)]), ...mods]}
      >
        <ListItem.HeadlineContent>
          <Text color={color}>{label}</Text>
        </ListItem.HeadlineContent>
        {loading ? (
          <ListItem.TrailingContent>
            <CircularProgressIndicator
              color={color}
              strokeWidth={2}
              modifiers={[size(20, 20)]}
            />
          </ListItem.TrailingContent>
        ) : null}
      </ListItem>
    );
  }

  if (fullWidth) mods.push(fillMaxWidth());
  const Component =
    variant === 'secondary'
      ? FilledTonalButton
      : variant === 'plain'
        ? TextButton
        : FilledButton;
  const colors =
    variant === 'destructive'
      ? { containerColor: p.danger, contentColor: p.onAccent }
      : undefined;
  return (
    <ControlHost style={style} width={fullWidth ? 'fill' : 'content'}>
      <Component
        onClick={off ? undefined : onPress}
        enabled={!off}
        colors={colors}
        modifiers={mods}
      >
        <Row verticalAlignment="center" horizontalArrangement={{ spacedBy: 8 }}>
          {loading ? (
            <CircularProgressIndicator
              strokeWidth={2}
              modifiers={[size(16, 16)]}
            />
          ) : null}
          <Text>{label}</Text>
        </Row>
      </Component>
    </ControlHost>
  );
}
