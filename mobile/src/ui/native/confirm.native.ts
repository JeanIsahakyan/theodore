/**
 * iOS / Android: the system alert (`UIAlertController`, Material
 * `AlertDialog`) through React Native's `Alert`.
 */
import { Alert } from 'react-native';
import type { ConfirmOptions } from './types';

/** Resolves `true` when the confirm action is tapped, `false` otherwise. */
export function confirm({
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive,
}: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: cancelLabel, style: 'cancel', onPress: () => resolve(false) },
        {
          text: confirmLabel,
          style: destructive ? 'destructive' : 'default',
          onPress: () => resolve(true),
        },
      ],
      // Android: a tap outside dismisses it, as a cancel.
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

/** A message with one OK button. */
export function notify(title: string, message?: string): Promise<void> {
  return new Promise((resolve) => {
    Alert.alert(title, message, [{ text: 'OK', onPress: () => resolve() }], {
      cancelable: true,
      onDismiss: () => resolve(),
    });
  });
}
