/**
 * 📎 in the composer (iOS, Android): a round button beside the chips; a tap
 * offers Photo library · Camera · File (iOS: an action sheet, Android: an
 * alert with the three choices).
 */
import { ActionSheetIOS, Alert, Platform, Pressable } from 'react-native';
import { usePalette } from '../../ui/theme';
import { SymbolImage } from '../symbol-image';
import type { PickSource } from './pick-files';

export const ATTACH_LABEL = 'Attach a file';
export const SOURCES: { source: PickSource; label: string }[] = [
  { source: 'library', label: 'Photo library' },
  { source: 'camera', label: 'Camera' },
  { source: 'file', label: 'File' },
];

export function AttachButton({
  onPick,
  disabled,
  busy,
  testID,
}: {
  onPick: (source: PickSource) => void;
  disabled?: boolean;
  /** A pick is under way. */
  busy?: boolean;
  testID?: string;
}) {
  const p = usePalette();
  const android = Platform.OS === 'android';
  const open = () => {
    if (disabled || busy) return;
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [...SOURCES.map((s) => s.label), 'Cancel'],
          cancelButtonIndex: SOURCES.length,
        },
        (i) => {
          const s = SOURCES[i];
          if (s) onPick(s.source);
        },
      );
      return;
    }
    Alert.alert(
      ATTACH_LABEL,
      undefined,
      [
        ...SOURCES.map((s) => ({
          text: s.label,
          onPress: () => onPick(s.source),
        })),
        { text: 'Cancel', style: 'cancel' as const },
      ],
      { cancelable: true },
    );
  };
  const size = android ? 40 : 34;
  return (
    <Pressable
      onPress={open}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={ATTACH_LABEL}
      accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      hitSlop={6}
      android_ripple={{ borderless: true, radius: size / 2 }}
      testID={testID}
      className={`items-center justify-center rounded-full bg-secondary active:opacity-70 ${disabled ? 'opacity-45' : ''}`}
      style={{ width: size, height: size }}
    >
      <SymbolImage name="attach" size={18} color={busy ? p.muted : p.text} />
    </Pressable>
  );
}
