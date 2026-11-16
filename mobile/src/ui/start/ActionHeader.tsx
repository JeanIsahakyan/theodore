/**
 * The pushed-screen header (`PushedHeader`) with an action on the trailing
 * side: a form's "Start" stays reachable while the keyboard is up, like a
 * navigation bar's confirm button / a Material top app bar action.
 *
 * ```text
 * iOS < 26       [‹ Back][   title, centered…   ][action]   sides equal
 * Android        [←][title, left-aligned…          ][action]   Material 3
 * web            [‹ Back][title, left-aligned…     ][action]
 * iOS 26+        not used: a native glass bar item (`glassHeader.ts`)
 * ```
 */
import type { ReactNode } from 'react';
import { PushedHeader } from '../../shell/PushedHeader';

export function ActionHeader({
  title,
  action,
}: {
  title: string;
  action?: ReactNode;
}) {
  return <PushedHeader title={title} action={action} />;
}
