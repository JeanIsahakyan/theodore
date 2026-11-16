/**
 * A small spinner for a row (a step still running). iOS and web: React
 * Native's `ActivityIndicator`, which is UIKit's own spinner on iOS. The
 * kit's `Progress` has one size, too big for a row.
 */
import { ActivityIndicator } from 'react-native';

export function Spinner({ color }: { color: string }) {
  return <ActivityIndicator size="small" color={color} />;
}
