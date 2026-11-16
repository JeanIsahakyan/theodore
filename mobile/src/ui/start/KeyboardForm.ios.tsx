/**
 * iOS: the kit's `Form` (SwiftUI, inset grouped) that also closes the
 * keyboard. The kit `Form` takes no modifiers yet, so this one is local.
 *
 * ```text
 * drag the form       ─▶ keyboard follows the finger down (interactively)
 * focused field       ─▶ SwiftUI keeps it above the keyboard itself
 *
 * No tap-to-dismiss gesture: adding one when the keyboard comes up changes
 * the Form's modifiers, SwiftUI rebuilds it, and the field that just took
 * focus loses it (the keyboard never stays up).
 * ```
 */
import { Form as SForm, Host } from '@expo/ui/swift-ui';
import { scrollDismissesKeyboard } from '@expo/ui/swift-ui/modifiers';
import { InForm } from '../native/context';
import { useHostTheme } from '../native/host.ios';
import type { FormProps } from '../native/types';

export function KeyboardForm({ children, testID }: FormProps) {
  const theme = useHostTheme();
  return (
    <Host {...theme} useViewportSizeMeasurement style={{ flex: 1 }}>
      <SForm
        testID={testID}
        modifiers={[scrollDismissesKeyboard('interactively')]}
      >
        <InForm.Provider value>{children}</InForm.Provider>
      </SForm>
    </Host>
  );
}
