/**
 * iOS 26+: the stack's own navigation bar, which is Liquid Glass, over
 * the content (content scrolls under it, as in Apple's apps). Before 26,
 * on Android and on web the headers stay opaque and above the content.
 *
 * ```text
 *                 Home's header                pushed screens
 * iOS 26+         native, glass, transparent   native, glass, back "‹" (minimal)
 * iOS < 26        native, opaque               PushedHeader (TopBar)
 * Android         Material 3 top app bar       PushedHeader (Material top app bar)
 * web             JS header                    PushedHeader (TopBar)
 * ```
 *
 * Under a glass header a screen starts at the top of the window:
 * scroll views inset themselves (`contentInsetAdjustmentBehavior`), a
 * SwiftUI `Form` follows the safe area, and anything else at the top
 * (the questions banner, a connection banner over a form) is pushed down
 * by `useGlassHeaderInset()`.
 */
import { createContext, useContext } from 'react';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { liquidGlass } from '../ui/native';

export const glassHeader = liquidGlass;

/**
 * Whether the header overlays this part of the screen: false below
 * something that already made room for it.
 */
export const UnderGlassHeader = createContext(true);

/** The header's height when it overlays the screen here, else 0. */
export function useGlassHeaderInset(): number {
  const height = useHeaderHeight();
  const under = useContext(UnderGlassHeader);
  return glassHeader && under ? height : 0;
}
