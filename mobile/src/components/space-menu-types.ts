/**
 * The space menu around a drawer row (docs/mobile.md "Archive"): the
 * platform's own context menu with the row's items (`spaceMenuItems`,
 * src/ui/spaceMenu.ts). Metro picks the platform's file:
 *
 * ```text
 * iOS      space-menu.ios.tsx      SwiftUI ContextMenu: the row is its trigger,
 *                                  a long press opens it (the system's haptic)
 * Android  space-menu.android.tsx  the row's long press (a light haptic) opens a
 *                                  Compose DropdownMenu anchored under the row
 * web      space-menu.tsx          right-click on the row, or ⋯ at its right
 *                                  (shown on hover, focus or the active row)
 *                                  ─▶ a small menu under the row's right edge
 * ```
 *
 * No items ─▶ the row alone, no menu. Destructive styling only on the item.
 */
import type { ReactNode } from 'react';
import type { SpaceMenuItem, SpaceMenuItemId } from '../ui/spaceMenu';

/** What the row gets from the menu: a long press to wire (Android), the ⋯
 *  button to place at its right (web). */
export interface SpaceMenuSlots {
  onLongPress?: () => void;
  trailing?: ReactNode;
}

export interface SpaceMenuProps {
  /** The space's name: the menu's heading where it has one. */
  title: string;
  items: readonly SpaceMenuItem[];
  onSelect: (id: SpaceMenuItemId) => void;
  /** Web: the ⋯ button shows (the row is hovered or active); else only
   *  while it has the focus. */
  revealed?: boolean;
  testID?: string;
  children: (slots: SpaceMenuSlots) => ReactNode;
}
