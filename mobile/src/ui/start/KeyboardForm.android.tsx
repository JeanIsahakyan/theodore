/**
 * Android: the kit's `Form` (a scrolling Compose column of Material cards)
 * that also closes the keyboard when the form is dragged. The kit `Form`
 * takes no modifiers yet, so this one is local. The screen keeps it above
 * the keyboard (`KeyboardScreen`); Back closes the keyboard as everywhere.
 *
 * No tap-to-close: a `clickable` column would merge every row into one
 * TalkBack node.
 */
import { Column, Host } from '@expo/ui/jetpack-compose';
import {
  paddingAll,
  scrollDismissesKeyboard,
  testID as testIDMod,
  verticalScroll,
} from '@expo/ui/jetpack-compose/modifiers';
import { usePalette } from '../theme';
import { InForm } from '../native/context';
import { useHostTheme } from '../native/host.android';
import type { FormProps } from '../native/types';

export function KeyboardForm({ children, testID }: FormProps) {
  const theme = useHostTheme();
  const p = usePalette();
  return (
    <Host {...theme} style={{ flex: 1, backgroundColor: p.background }}>
      <Column
        verticalArrangement={{ spacedBy: 20 }}
        modifiers={[
          scrollDismissesKeyboard(),
          verticalScroll(),
          paddingAll(16),
          ...(testID ? [testIDMod(testID)] : []),
        ]}
      >
        <InForm.Provider value>{children}</InForm.Provider>
      </Column>
    </Host>
  );
}
