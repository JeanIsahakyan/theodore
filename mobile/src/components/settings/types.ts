/**
 * Props of the settings rows drawn per platform (`*.ios.tsx`,
 * `*.android.tsx`, `*.tsx`), and the kit icon an Android row draws for a
 * symbol (Compose's `Icon` takes the kit's vector drawables, not
 * `expo-symbols`).
 */
import type { Choice, IconName } from '../../ui/native/types';
import type { SymbolName } from '../symbol-image';

export interface SettingsToggleRowProps {
  icon: SymbolName;
  label: string;
  subtitle?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  testID?: string;
}

/** A row that opens a native menu of single choices (Appearance). */
export interface SettingsMenuRowProps<T extends string> {
  icon: SymbolName;
  label: string;
  choices: readonly Choice<T>[];
  value: T;
  onChange: (value: T) => void;
  testID?: string;
}

/** Android: the Material Symbol (kit drawable) for a row's symbol. */
export const KIT_ICON: Partial<Record<SymbolName, IconName>> = {
  bell: 'notifications',
  appearance: 'theme',
};
