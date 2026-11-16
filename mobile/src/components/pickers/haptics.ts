import * as Haptics from 'expo-haptics';

const web = process.env.EXPO_OS === 'web';

/** A selection tick (none on web). */
export function tick(): void {
  if (!web) void Haptics.selectionAsync().catch(() => {});
}
