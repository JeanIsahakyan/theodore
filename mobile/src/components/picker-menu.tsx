// Adapted from EvanBacon/chat-template (MIT)
/**
 * The composer's picker (the template's model picker): a compact button
 * that opens a menu of single choices, its groups e.g. Agent · Model ·
 * Effort.
 *
 * ```text
 * iOS      SwiftUI Menu, a Picker submenu per group (the kit's Menu)
 * Android  assist chip ─▶ Material 3 modal bottom sheet (picker-menu.android.tsx)
 * web      pill ─▶ sheet (the kit's Menu)
 * ```
 */
import { Menu } from '../ui/native';
import type { MenuProps } from '../ui/native/types';

export function PickerMenu(props: MenuProps) {
  return <Menu {...props} />;
}
