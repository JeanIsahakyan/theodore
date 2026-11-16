/**
 * Props of `ChatField`: the kit's `TextField` plus what a chat needs and the
 * kit doesn't have yet (docs/mobile.md "Native UI"): a ref to focus it
 * (Revise puts the cursor in the composer) and a focus callback (the
 * question card keeps itself in view).
 */
import type { Ref } from 'react';
import type { TextFieldProps } from './native';

export interface ChatFieldHandle {
  focus: () => void;
}

export interface ChatFieldProps extends TextFieldProps {
  ref?: Ref<ChatFieldHandle>;
  /** The field took focus. */
  onFocus?: () => void;
}
