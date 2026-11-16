/** Android: a Material 3 `FilterChip` (a check when picked). */
import { FilterChip, Text } from '@expo/ui/jetpack-compose';
import { semantics } from '@expo/ui/jetpack-compose/modifiers';
import { ControlHost } from './native/host.android';
import type { OptionChipProps } from './optionChipTypes';

export function OptionChip({
  label,
  selected,
  onPress,
  disabled,
  accessibilityLabel,
}: OptionChipProps) {
  return (
    <ControlHost>
      <FilterChip
        selected={selected}
        enabled={!disabled}
        onClick={disabled ? undefined : onPress}
        modifiers={
          accessibilityLabel
            ? [semantics({ contentDescription: accessibilityLabel })]
            : undefined
        }
      >
        <FilterChip.Label>
          <Text>{label}</Text>
        </FilterChip.Label>
      </FilterChip>
    </ControlHost>
  );
}
