// Adapted from EvanBacon/chat-template (MIT)
import { View } from 'react-native';

/**
 * Android: the Material 3 drag handle (32 × 4 dp, `onSurfaceVariant`) on
 * top of a sheet presented as a stack screen (`formSheet`).
 */
export function AndroidGrabber() {
  return (
    <View className="items-center pt-4 pb-2">
      <View className="h-1 w-8 rounded-full bg-muted-foreground/40" />
    </View>
  );
}
