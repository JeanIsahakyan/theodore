/** Android: a `ListItem` with a Material 3 `Switch`; the whole row toggles. */
import { ListItem, Switch as CSwitch, Text } from '@expo/ui/jetpack-compose';
import {
  alpha,
  semantics,
  testID as testIDMod,
  toggleable,
} from '@expo/ui/jetpack-compose/modifiers';
import { usePalette } from '../theme';
import { ControlHost } from './host.android';
import type { SwitchProps } from './types';

export function Switch({
  label,
  detail,
  value,
  onValueChange,
  disabled,
  accessibilityLabel,
  testID,
  style,
}: SwitchProps) {
  const p = usePalette();
  return (
    <ControlHost style={style} width="fill">
      <ListItem
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
