/**
 * The header of a screen pushed over the tabs (a space, Start a space):
 * the kit's `TopBar` with Back. iOS before 26 and web: "‹ Back" and the
 * title on one line (the back button never shrinks, a long title ends in
 * "…"; the native bar cut "Back" to "Bac"). Android: a Material 3 top app
 * bar. iOS 26+ uses the native glass navigation bar instead
 * (`glassHeader.ts`).
 */
import type { ReactNode } from 'react';
import { router, type Href } from 'expo-router';
import { TopBar } from '../ui/native';

export function goBack() {
  if (router.canGoBack()) router.back();
  else router.replace('/' as Href);
}

export function PushedHeader({
  title,
  action,
}: {
  title: string;
  action?: ReactNode;
}) {
  return <TopBar title={title} onBack={goBack} action={action} />;
}
