/**
 * Tab bar icons drawn with plain Views: no icon font to load, identical on
 * iOS, Android and the web.
 */
import { View, type ColorValue } from 'react-native';

interface IconProps {
  color: ColorValue;
  size: number;
}

/** Three stacked rows: a list of spaces. */
export function SpacesIcon({ color, size }: IconProps) {
  const bar = { height: 2.5, borderRadius: 2, backgroundColor: color };
  return (
    <View
      style={{
        width: size,
        height: size,
        justifyContent: 'space-evenly',
        padding: size * 0.12,
      }}
    >
      <View style={bar} />
      <View style={[bar, { width: '75%' }]} />
      <View style={bar} />
    </View>
  );
}

/** A screen on a stand. */
export function DevicesIcon({ color, size }: IconProps) {
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <View
        style={{
          width: size * 0.8,
          height: size * 0.55,
          borderRadius: 3,
          borderWidth: 2,
          borderColor: color,
        }}
      />
      <View
        style={{
          width: size * 0.4,
          height: 2.5,
          marginTop: 2,
          borderRadius: 2,
          backgroundColor: color,
        }}
      />
    </View>
  );
}

/** A ring around a dot. */
export function SettingsIcon({ color, size }: IconProps) {
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <View
        style={{
          width: size * 0.72,
          height: size * 0.72,
          borderRadius: size,
          borderWidth: 2.5,
          borderColor: color,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <View
          style={{
            width: size * 0.22,
            height: size * 0.22,
            borderRadius: size,
            backgroundColor: color,
          }}
        />
      </View>
    </View>
  );
}
