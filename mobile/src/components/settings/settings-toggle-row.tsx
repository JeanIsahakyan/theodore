// Adapted from EvanBacon/chat-template (MIT)
/**
 * iOS and web: a settings row with a switch (the template's toggle row):
 * `UISwitch` on iOS, React Native's on web. A tick of haptics on change.
 * Android: `settings-toggle-row.android.tsx` (Material 3).
 *
 * ```text
 * [icon]  Notifications                         (  ●)
 *         Questions and finished spaces, …
 * ```
 */
import { Switch, Text, View } from 'react-native';
import { usePalette } from '../../ui/theme';
import { SymbolImage } from '../symbol-image';
import { tick } from './feedback';
import {
  LABEL_CLASS,
  ROW_CLASS,
  ROW_ICON_SIZE,
  SUBTITLE_CLASS,
} from './settings-row';
import type { SettingsToggleRowProps } from './types';

const web = process.env.EXPO_OS === 'web';

export function SettingsToggleRow({
  icon,
  label,
  subtitle,
  value,
  onValueChange,
  disabled,
  testID,
}: SettingsToggleRowProps) {
  const p = usePalette();
  return (
    <View className={`${ROW_CLASS} ${disabled ? 'opacity-50' : ''}`}>
      <SymbolImage name={icon} size={ROW_ICON_SIZE} color={p.text} />
      <View className="flex-1 gap-0.5">
        <Text className={LABEL_CLASS}>{label}</Text>
        {subtitle ? <Text className={SUBTITLE_CLASS}>{subtitle}</Text> : null}
      </View>
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={(on) => {
          tick();
          onValueChange(on);
        }}
        accessibilityLabel={label}
        testID={testID}
        // iOS keeps the system green; web takes the accent.
        {...(web ? { trackColor: { false: p.border, true: p.accent } } : {})}
      />
    </View>
  );
}
