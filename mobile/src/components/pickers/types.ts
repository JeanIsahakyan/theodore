/**
 * The composer's sheet chips (docs/mobile.md "New space"): a chip that
 * opens a picker sheet, the same props on every platform.
 *
 * ```text
 * iOS      SwiftUI bordered capsule ─▶ push the sheet's route (formSheet)
 * Android  AssistChip ─▶ Material 3 ModalBottomSheet (Compose), in place
 * web      pill ─▶ a modal over the window
 * ```
 */
import type { ReactNode } from 'react';
import type { SymbolName } from '../symbol-image';

/** `activity`: a space's plan, subagents and sub-spaces (`src/ui/ActivitySheet`);
 *  `accounts`: the accounts signed in here (`src/components/accounts`);
 *  `text`: a long-pressed message as selectable text
 *  (`src/components/chat/select-text-sheet.tsx`). */
export type SheetKind =
  'model' | 'computer' | 'project' | 'activity' | 'accounts' | 'text';

/** A sheet to open from a chip or a row (`useSheet`, per platform). */
export interface SheetHandle {
  open: () => void;
  isOpen: boolean;
  /** Render it next to the trigger (Android, web); iOS: `null` (a route). */
  element: ReactNode;
}

export interface SheetChipProps {
  sheet: SheetKind;
  /** The model sheet's target: a space's id; none: Home's draft. */
  space?: string | null;
  /** Before the label (Home's project / computer chips). */
  icon?: SymbolName;
  /** Short, what the chip shows ("Opus 4.1"). */
  label: string;
  /** After the label, muted ("High"). */
  detail?: string | null;
  /** What it is read as ("Agent: Claude, Opus 4.1, High"). */
  accessibilityLabel: string;
  /** Nothing else to choose: no ⌄, opens nothing, read as text. */
  fixed?: boolean;
  disabled?: boolean;
  testID?: string;
}
