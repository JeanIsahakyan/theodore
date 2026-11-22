/**
 * The text the Select text sheet shows (zustand): set by the message that
 * was long-pressed, read by the sheet (an iOS route can't carry a message
 * in its URL). One at a time.
 */
import { create } from 'zustand';
import type { MessageKind } from '../ui/messageMenu';

export interface SelectTextState {
  text: string;
  kind: MessageKind;
}

export const useSelectText = create<SelectTextState>(() => ({
  text: '',
  kind: 'reply',
}));

export function setSelectText(text: string, kind: MessageKind): void {
  useSelectText.setState({ text, kind });
}
