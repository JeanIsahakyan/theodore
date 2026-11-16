/**
 * iOS: the kit's `Form` (SwiftUI, inset grouped) that also closes the
 * keyboard. The kit `Form` takes no modifiers yet, so this one is local.
 *
 * ```text
 * drag the form       ─▶ keyboard follows the finger down (interactively)
 * tap off a control   ─▶ keyboard closes (only while it is up)
 * focused field       ─▶ SwiftUI keeps it above the keyboard itself
 * ```
 */
import { Form as SForm, Host } from '@expo/ui/swift-ui';
import {
  onTapGesture,
  scrollDismissesKeyboard,
} from '@expo/ui/swift-ui/modifiers';
import { Keyboard } from 'react-native';
import { useKeyboardUp } from '../KeyboardSafe';
import { InForm } from '../native/context';
import { useHostTheme } from '../native/host.ios';
import type { FormProps } from '../native/types';

export function KeyboardForm({ children, testID }: FormProps) {
  const theme = useHostTheme();
  const keyboardUp = useKeyboardUp();
  return (
    <Host {...theme} useViewportSizeMeasurement style={{ flex: 1 }}>
      <SForm
        testID={testID}
        modifiers={[
          scrollDismissesKeyboard('interactively'),
          ...(keyboardUp ? [onTapGesture(() => Keyboard.dismiss())] : []),
        ]}
      >
        <InForm.Provider value>{children}</InForm.Provider>
      </SForm>
    </Host>
  );
}
