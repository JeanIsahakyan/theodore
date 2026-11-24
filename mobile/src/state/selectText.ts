/**
 * Which message is in Select text mode (zustand): the one long-pressed
 * message whose text is a selectable field in place (docs/mobile.md
 * "Select text"). One at a time: selecting another closes the first.
 */
import { create } from 'zustand';

export interface SelectTextState {
  /** The `LongPressMenu` instance selecting, or null. */
  owner: string | null;
}

export const useSelectText = create<SelectTextState>(() => ({ owner: null }));

export function startSelecting(owner: string): void {
  useSelectText.setState({ owner });
}

/** Closes `owner`'s mode (only if it is still the one selecting). */
export function stopSelecting(owner: string): void {
  if (useSelectText.getState().owner === owner)
    useSelectText.setState({ owner: null });
}
