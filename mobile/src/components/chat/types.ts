/**
 * The composer's props (`prompt-input.tsx` iOS/Android, `.web.tsx`): a
 * controlled field, Send (Stop while `running`), and slots for chips.
 *
 * ```text
 * ╭──────────────────────────────────────────╮
 * │ placeholder / text (grows to ~6 lines)   │
 * │ [leading chips…]           [trailing] (↑)│   (↑) Send · (■) Stop · spinner
 * ╰──────────────────────────────────────────╯
 * ```
 */
import type { ReactElement, ReactNode, Ref } from 'react';
import type { TextInputInstance } from 'react-native';

export interface PromptInputProps {
  value: string;
  onChangeText: (text: string) => void;
  /** Send: also the hardware keyboard's Enter on web (Shift+Enter: newline). */
  onSubmit: () => void;
  placeholder?: string;
  /** Field and buttons off (nothing can be sent now). */
  disabled?: boolean;
  /** The field takes typing; default: not `disabled`. */
  editable?: boolean;
  /** Send is in flight: a spinner on the button, not pressable. */
  sending?: boolean;
  /** A turn runs: the button is Stop (`onStop`); the field follows `editable`. */
  running?: boolean;
  onStop?: () => void;
  /** Stop is in flight. */
  stopping?: boolean;
  /** While `running`, Send stays next to Stop: the message joins the
   *  space's queue. */
  queue?: boolean;
  /** Send allowed; default: the text isn't blank. */
  canSubmit?: boolean;
  /** Above the field, inside the surface (the attached files' previews). */
  above?: ReactNode;
  /** Chips on the row under the field, left (agent · model · effort). */
  leading?: ReactNode;
  /** Before the send button. */
  trailing?: ReactNode;
  /** A line over the composer (why the last send failed). */
  error?: string | null;
  autoFocus?: boolean;
  /** Default 20 000. */
  maxLength?: number;
  /** Send's accessible name; default "Send". */
  submitLabel?: string;
  inputRef?: Ref<TextInputInstance>;
  testID?: string;
}

export interface ComposerDockProps {
  children: ReactNode;
  /**
   * `false` (default): in the layout, under the content, lifted by the
   * keyboard (the content above shrinks). `true`: floats over the content
   * at the bottom (a chat scrolling under a glass composer); the content
   * then insets itself by `onHeight`.
   */
  floating?: boolean;
  /** The dock's height, for content scrolling under a floating one. */
  onHeight?: (height: number) => void;
}

/** Space between a floating dock and the safe area or the keyboard. */
export const DOCK_GAP = 8;

export interface ConversationHandle {
  /** To the newest row (after a send, or a field in the footer focused). */
  scrollToEnd: () => void;
}

export interface ConversationProps<T> {
  ref?: Ref<ConversationHandle>;
  data: readonly T[];
  renderItem: (info: { item: T; index: number }) => ReactNode;
  keyExtractor: (item: T) => string;
  /** Above the first row (the space's details). */
  header?: ReactElement | null;
  /** After the last row, always mounted (the live turn, the question). */
  footer?: ReactElement | null;
  /** Shown when `data` is empty. */
  empty?: ReactElement | null;
  /** The floating composer's height (`ComposerDock`'s `onHeight`). */
  composerHeight: number;
  /** Room for a header drawn over the list (the iOS 26 glass bar). */
  topInset?: number;
  /** `ConversationScrollButton`, drawn over the list. */
  children?: ReactNode;
}
