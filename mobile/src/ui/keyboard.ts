/**
 * Keyboard rules for the screens with a text field, per platform. Pure, so
 * the tests read them without React Native.
 *
 * | Platform | Keyboard            | Avoid with | Dismiss on scroll |
 * | -------- | ------------------- | ---------- | ----------------- |
 * | iOS      | drawn over the app  | padding    | interactive       |
 * | Android  | edge-to-edge: over  | padding    | on-drag           |
 * | web      | the browser's own   | nothing    | none              |
 */

export type AvoidBehavior = 'padding' | undefined;
export type DismissMode = 'interactive' | 'on-drag' | 'none';

/** `KeyboardAvoidingView`'s `behavior`: native windows don't resize. */
export const avoidBehavior = (os: string): AvoidBehavior =>
  os === 'ios' || os === 'android' ? 'padding' : undefined;

/** A scroll view's `keyboardDismissMode`. */
export const dismissMode = (os: string): DismissMode =>
  os === 'ios' ? 'interactive' : os === 'android' ? 'on-drag' : 'none';

/**
 * Space under a bar pinned to the bottom: the home indicator's inset, but
 * not while the keyboard covers it (the bar then sits on the keyboard).
 */
export const bottomPad = (
  base: number,
  insetBottom: number,
  keyboardUp: boolean,
): number => (keyboardUp ? base : base + insetBottom);
