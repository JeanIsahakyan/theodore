/**
 * Android: a `ListItem` with a Material 3 `Switch`; the whole row toggles;
 * `icon` leads it.
 */
import {
  Icon,
  ListItem,
  Switch as CSwitch,
  Text,
} from '@expo/ui/jetpack-compose';
import {
  alpha,
  semantics,
  testID as testIDMod,
  toggleable,
} from '@expo/ui/jetpack-compose/modifiers';
import { usePalette } from '../theme';
import { ControlHost } from './host.android';
import { MATERIAL } from './materialIcons';
import type { SwitchProps } from './types';

export function Switch({
  label,
  detail,
  value,
  onValueChange,
  disabled,
  icon,
  accessibilityLabel,
  testID,
  style,
}: SwitchProps) {
  const p = usePalette();
  return (
    <ControlHost style={style} width="fill">
      <ListItem
        // Remounted when it turns on or off: Compose keeps the `toggleable`
        // it was mounted with.
        key={disabled ? 'off' : 'on'}
        colors={{ containerColor: 'transparent' }}
        modifiers={[
          toggleable(value, () => onValueChange(!value), {
            role: 'switch',
            enabled: !disabled,
          }),
          ...(disabled ? [alpha(0.38)] : []),
          semantics({ contentDescription: accessibilityLabel ?? label }),
          ...(testID ? [testIDMod(testID)] : []),
        ]}
      >
        {icon ? (
          <ListItem.LeadingContent>
            <Icon source={MATERIAL[icon]} size={24} />
          </ListItem.LeadingContent>
        ) : null}
        <ListItem.HeadlineContent>
          <Text color={p.text}>{label}</Text>
        </ListItem.HeadlineContent>
        {detail ? (
          <ListItem.SupportingContent>
            <Text color={p.muted}>{detail}</Text>
          </ListItem.SupportingContent>
        ) : null}
        <ListItem.TrailingContent>
          {/* No onCheckedChange: the row's `toggleable` takes the input. */}
          <CSwitch value={value} enabled={!disabled} />
        </ListItem.TrailingContent>
      </ListItem>
    </ControlHost>
  );
}
