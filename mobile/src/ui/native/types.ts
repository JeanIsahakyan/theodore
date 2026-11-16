/**
 * Props of the native kit (docs/mobile.md "Native UI"). Every component has
 * the same props on iOS (SwiftUI, `*.ios.tsx`), Android (Jetpack Compose,
 * `*.android.tsx`) and web (React Native, `*.tsx`).
 *
 * Labels: what a component shows is also what VoiceOver / TalkBack read and
 * what Maestro taps by text; `accessibilityLabel` overrides it when the
 * visible text is not enough ("Switch to Acme" for a row showing "Acme").
 */
import type { ReactElement, ReactNode } from 'react';
import type { StyleProp, ViewProps, ViewStyle } from 'react-native';

interface Common {
  accessibilityLabel?: string;
  testID?: string;
}

/** Placement of a standalone control (ignored inside a `Form`). */
interface Placed {
  style?: StyleProp<ViewStyle>;
}

/**
 * A control floating over content (a composer, a bar): on iOS 26+ it sits
 * on Liquid Glass; below iOS 26, on Android and on web it keeps its plain
 * look. Ignored inside a `Form`.
 */
interface Floating {
  glass?: boolean;
}

/**
 * `glass` / `glassProminent`: Liquid Glass on iOS 26+ (`.glass` /
 * `.glassProminent`), `secondary` / `primary` below iOS 26 and on web,
 * Material 3 tonal / filled on Android. For actions floating over content
 * (a composer's Send, a bar's main action); `primary` / `secondary` stay
 * the in-content buttons.
 */
export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'plain'
  | 'destructive'
  | 'glass'
  | 'glassProminent';

export interface ButtonProps extends Common, Placed {
  label: string;
  onPress: () => void;
  /** Default `secondary`. */
  variant?: ButtonVariant;
  disabled?: boolean;
  /** A spinner next to the label; not pressable meanwhile. */
  loading?: boolean;
  /** Stretch to the width it is given (a form's main action). */
  fullWidth?: boolean;
}

export interface Choice<T extends string> {
  value: T;
  label: string;
  accessibilityLabel?: string;
}

export interface SegmentedProps<T extends string>
  extends Common, Placed, Floating {
  /** What is being chosen ("Mode"): read by screen readers, a row label in a `Form`. */
  label: string;
  choices: readonly Choice<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}

export interface SelectProps<T extends string>
  extends Common, Placed, Floating {
  /** What is being chosen ("Device"): the row's label. */
  label: string;
  choices: readonly Choice<T>[];
  /** `null`: nothing chosen yet, `placeholder` shows. */
  value: T | null;
  onChange: (value: T) => void;
  /** Default "Choose…". */
  placeholder?: string;
  disabled?: boolean;
}

export interface SwitchProps extends Common, Placed {
  label: string;
  /** A second, smaller line under the label. */
  detail?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
}

export type SubmitLabel = 'done' | 'go' | 'send' | 'search' | 'next';

export interface TextFieldProps extends Common, Placed, Floating {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  /** Grows with its text, from `minLines` (default 3) up to `maxLines` (default 8). */
  multiline?: boolean;
  minLines?: number;
  maxLines?: number;
  /** The return key (single line) or the keyboard's action. */
  onSubmit?: () => void;
  submitLabel?: SubmitLabel;
  autoFocus?: boolean;
  disabled?: boolean;
  maxLength?: number;
  autoCapitalize?: 'none' | 'sentences' | 'words';
  autoCorrect?: boolean;
}

export interface ProgressProps extends Common, Placed {
  /** 0…1; omitted: indeterminate (a spinner, or a moving bar). */
  value?: number | null;
  /** Default `circular`. */
  variant?: 'circular' | 'linear';
}

export interface FormProps {
  /** `Section`s (and `FormSlot`s). */
  children: ReactNode;
  testID?: string;
}

export interface SectionProps {
  title?: string;
  /** A note under the section. */
  footer?: string;
  /** `Row`, `Switch`, `Select`, `Segmented`, `TextField`, `Button`, `FormSlot`. */
  children: ReactNode;
}

export interface RowProps extends Common {
  label: string;
  /** Under the label, smaller. */
  detail?: string;
  /** On the trailing side, secondary color (Settings' "Version  1.0"). */
  value?: string;
  onPress?: () => void;
  /** A navigation row's "›" (iOS and web; Material lists have none). */
  chevron?: boolean;
  /** A checkmark: the chosen one of a list of rows. */
  selected?: boolean;
  /** The label in the danger color ("Sign out"). */
  destructive?: boolean;
  /** A spinner on the trailing side; not pressable meanwhile. */
  loading?: boolean;
  disabled?: boolean;
}

/** Any React Native content inside a `Form` (one element). */
export interface FormSlotProps {
  children: ReactElement;
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel: string;
  /** Default "Cancel". */
  cancelLabel?: string;
  /** The confirm action in the danger color. */
  destructive?: boolean;
}

export interface GlassProps extends ViewProps {
  /** `capsule` (a pill, a banner) or `rounded` (a card, a panel). Default `rounded`. */
  shape?: 'capsule' | 'rounded';
  /** Corner radius of `rounded`. Default 20. */
  radius?: number;
  /** Reacts to touch (a pressable surface). Fixed at mount. */
  interactive?: boolean;
  /** A tint over the glass (iOS 26+); keep it light, e.g. a color at 20 %. */
  tint?: string;
  /**
   * What it is without glass (iOS before 26, Android, web): `surface` (a
   * card), `muted` (a quiet pill), `none` (transparent). Default `surface`.
   */
  fallback?: 'surface' | 'muted' | 'none';
  children?: ReactNode;
}

export interface TopBarProps {
  title: string;
  /** "Back" (the leading button); none without it. */
  onBack?: () => void;
  /** One trailing action, a kit `Button` (`plain` in a bar). */
  action?: ReactNode;
}
