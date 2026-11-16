/** Web: a row with React Native's `Switch`; `icon` leads it. */
import { Switch as RNSwitch, Text, View } from 'react-native';
import { usePalette } from '../theme';
import { webStyles } from './rnStyles';
import { WebIcon } from './webIcons';
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
    <View style={[webStyles.row, style]}>
      {icon ? <WebIcon name={icon} color={p.text} /> : null}
      <View style={webStyles.rowText}>
        <Text style={[webStyles.rowLabel, { color: p.text }]}>{label}</Text>
        {detail ? (
          <Text style={[webStyles.rowDetail, { color: p.muted }]}>
            {detail}
          </Text>
        ) : null}
      </View>
      <RNSwitch
        accessibilityLabel={accessibilityLabel ?? label}
        testID={testID}
        value={value}
        disabled={disabled}
        onValueChange={onValueChange}
        trackColor={{ true: p.accent, false: p.border }}
        thumbColor="#FFFFFF"
      />
    </View>
  );
}
