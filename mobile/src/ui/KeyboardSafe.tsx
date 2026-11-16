/**
 * Keeping fields and their buttons above the software keyboard (rules in
 * `keyboard.ts`).
 *
 * ```text
 * screen under a header ─▶ KeyboardScreen (padding, offset = header height)
 *   ├─ scroll view: keyboardShouldPersistTaps="handled", dismissMode(os)
 *   │    └─ DismissKeyboard: a tap outside a field closes the keyboard
 *   └─ bar pinned to the bottom (composer) ─▶ rides on the keyboard
 * ```
 */
import { useEffect, useState, type ReactNode } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { avoidBehavior, dismissMode } from './keyboard';

export const keyboardDismissMode = dismissMode(Platform.OS);

/** A whole screen that shrinks by the part of it the keyboard covers. */
export function KeyboardScreen({ children }: { children: ReactNode }) {
  const header = useHeaderHeight();
  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={avoidBehavior(Platform.OS)}
      keyboardVerticalOffset={header}
    >
      {children}
    </KeyboardAvoidingView>
  );
}

/**
 * A tap on anything that isn't a control closes the keyboard. Not a button
 * for screen readers; on web the browser already does this.
 */
export function DismissKeyboard({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessible={false}
      onPress={Platform.OS === 'web' ? undefined : Keyboard.dismiss}
      style={style}
    >
      {children}
    </Pressable>
  );
}

/** Whether the software keyboard is up (iOS: as it starts to move). */
export function useKeyboardUp(): boolean {
  const [up, setUp] = useState(() => Keyboard.isVisible());
  useEffect(() => {
    const ios = Platform.OS === 'ios';
    const show = Keyboard.addListener(
      ios ? 'keyboardWillShow' : 'keyboardDidShow',
      () => setUp(true),
    );
    const hide = Keyboard.addListener(
      ios ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setUp(false),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return up;
}

const styles = StyleSheet.create({ flex: { flex: 1 } });
