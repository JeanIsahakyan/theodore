/**
 * Android: a Material 3 list item with a `Switch` (the kit's `Switch`,
 * Compose): the whole row toggles, a tick of haptics on change. Its
 * metrics (16 dp sides, 24 dp icon, 16 sp label) match `SettingsRow`.
 */
import { Switch } from '../../ui/native';
import { tick } from './feedback';
import { KIT_ICON, type SettingsToggleRowProps } from './types';

export function SettingsToggleRow({
  icon,
  label,
  subtitle,
  value,
  onValueChange,
  disabled,
  testID,
}: SettingsToggleRowProps) {
  const kitIcon = KIT_ICON[icon];
  return (
    <Switch
      label={label}
      {...(subtitle ? { detail: subtitle } : {})}
      {...(kitIcon ? { icon: kitIcon } : {})}
      value={value}
      disabled={disabled}
      onValueChange={(on) => {
        tick();
        onValueChange(on);
      }}
      testID={testID}
    />
  );
}
