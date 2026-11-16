/**
 * One option of a question, picked or not (several may be). The kit has no
 * multi-select chip yet: `Segmented` and `Select` pick exactly one.
 */
export interface OptionChipProps {
  label: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
}
