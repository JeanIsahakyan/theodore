/**
 * Haptics and the clipboard for Settings and Devices. Haptics are
 * native only (nothing on web).
 *
 * ```text
 * a toggle, a menu pick   ─▶ tick()      selection
 * fingerprint copied      ─▶ copied()    success
 * ```
 */
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';

const native = process.env.EXPO_OS !== 'web';

export function tick(): void {
  if (native) void Haptics.selectionAsync();
}

export function copied(): void {
  if (native)
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
}

/** Puts `text` on the clipboard; false when the platform refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    return (await Clipboard.setStringAsync(text)) !== false;
  } catch {
    return false;
  }
}
