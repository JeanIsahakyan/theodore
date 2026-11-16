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
export type SheetKind = 'model' | 'where';

export interface SheetChipProps {
  sheet: SheetKind;
  /** The model sheet's target: a space's id; none: Home's draft. */
  space?: string | null;
  /** Short, what the chip shows ("Opus 4.1 · High"). */
  label: string;
  /** What it is read as ("Agent: Claude, Opus 4.1, High"). */
  accessibilityLabel: string;
  disabled?: boolean;
  testID?: string;
}
