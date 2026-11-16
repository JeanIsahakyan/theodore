/**
 * How a chat list closes the software keyboard, per platform. Pure, so the
 * tests read it without React Native. Riding on the keyboard is
 * react-native-keyboard-controller's (`components/chat`).
 *
 * | Platform | Keyboard            | Dismiss on scroll |
 * | -------- | ------------------- | ----------------- |
 * | iOS      | drawn over the app  | interactive       |
 * | Android  | edge-to-edge: over  | on-drag           |
 * | web      | the browser's own   | none              |
 */

export type DismissMode = 'interactive' | 'on-drag' | 'none';

/** A scroll view's `keyboardDismissMode`. */
export const dismissMode = (os: string): DismissMode =>
  os === 'ios' ? 'interactive' : os === 'android' ? 'on-drag' : 'none';
