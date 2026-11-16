/**
 * The tabs' titles. Native tabs draw no header: on iOS and Android the
 * stack around them (`app/(app)/_layout.tsx`) shows the focused tab's title
 * in its native header; the web's JS tabs use them as their own titles.
 */
export const TAB_TITLES = {
  index: 'Spaces',
  devices: 'Devices',
  settings: 'Settings',
} as const;

/** The title of the focused tab route (`undefined`: the first, Spaces). */
export function tabTitle(route: string | undefined): string {
  return TAB_TITLES[(route ?? 'index') as keyof typeof TAB_TITLES] ?? 'Spaces';
}
