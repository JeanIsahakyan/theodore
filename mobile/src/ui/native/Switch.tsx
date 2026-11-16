/** Web: a row with React Native's `Switch`. */
import { Switch as RNSwitch, Text, View } from 'react-native';
import { usePalette } from '../theme';
import { webStyles } from './rnStyles';
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
    <View style={[webStyles.row, style]}>
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
