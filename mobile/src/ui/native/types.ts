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
import type { IconName } from './icons';

export type { IconName } from './icons';

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
 * A leading glyph on a settings row (SF Symbol in a SwiftUI `Label` on iOS,
 * a Material Symbol as the `ListItem`'s leading content on Android, Lucide
 * on web). Read by no screen reader: the label says it.
 */
interface WithIcon {
  icon?: IconName;
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
  /**
   * Stretch to the width it is given (a form's main action). In a `Form`:
   * iOS, a row with the label centered; Android and web, a real button
   * across the screen when its `Section` is `plain` (else a row).
   */
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

/**
 * In a `Form`: a settings row "Label   Value" that opens the choices (iOS
 * `Picker` `.menu`, Android `ListItem` + `DropdownMenu`, web a row that
 * unfolds them). Standalone: a menu button / an exposed dropdown field.
 */
export interface SelectProps<T extends string>
  extends Common, Placed, Floating, WithIcon {
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

/** One single choice of a `Menu` ("Model": Opus, Sonnet, …). */
export interface MenuGroup<T extends string = string> {
  /** What it chooses: a submenu (iOS), a heading (Android, web). */
  label: string;
  choices: readonly Choice<T>[];
  /** The chosen one (a checkmark); `null`: none. */
  value: T | null;
  onChange: (value: T) => void;
}

/**
 * A compact button that opens a menu of single choices (a composer's
 * agent · model · effort). iOS: SwiftUI `Menu` (glass on iOS 26+ with
 * `glass`, bordered capsule below), each group a `.menu` `Picker`
 * submenu; Android: Material 3 `AssistChip` + `DropdownMenu`; web: a pill
 * and a sheet of the groups.
 */
export interface MenuProps extends Common, Placed, Floating {
  /** What the button shows ("Opus 4.1 · High"); also its accessible name
   *  unless `accessibilityLabel` is set. */
  label: string;
  groups: readonly MenuGroup[];
  disabled?: boolean;
}

export interface SwitchProps extends Common, Placed, WithIcon {
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
  /**
   * No card (Android, web): the children sit on the screen, for a lone
   * `fullWidth` action (Sign out). iOS: a section like any other.
   */
  plain?: boolean;
  /** `Row`, `Switch`, `Select`, `Segmented`, `TextField`, `Button`, `FormSlot`. */
  children: ReactNode;
}

export interface RowProps extends Common, WithIcon {
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
