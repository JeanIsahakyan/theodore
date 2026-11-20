/**
 * The kit's icons (a `Row`'s, a `Switch`'s, a `Select`'s leading glyph):
 * one name, each platform's own set.
 *
 * | Platform | Draws | Where |
 * | --- | --- | --- |
 * | iOS | SF Symbol in a SwiftUI `Label` | `SF` below |
 * | Android | Material Symbol (vector drawable, `assets/icons`) | `./materialIcons.ts` |
 * | web | Lucide | `./webIcons.tsx` |
 */
import type { Image } from '@expo/ui/swift-ui';
import type { ComponentProps } from 'react';

type SFSymbol = NonNullable<ComponentProps<typeof Image>['systemName']>;

export const SF = {
  theme: 'circle.lefthalf.filled',
  email: 'envelope',
  person: 'person',
  organization: 'building.2',
  phone: 'iphone',
  status: 'dot.radiowaves.left.and.right',
  notifications: 'bell',
  info: 'info.circle',
  server: 'server.rack',
  computer: 'desktopcomputer',
  globe: 'globe',
  fingerprint: 'touchid',
  trusted: 'checkmark.seal.fill',
} as const satisfies Record<string, SFSymbol>;

export type IconName = keyof typeof SF;

/** A device kind's glyph (desktop | daemon | mobile | web | mcp). */
export function kindIcon(kind: string): IconName {
  switch (kind) {
    case 'daemon':
      return 'server';
    case 'mobile':
      return 'phone';
    case 'web':
    case 'mcp':
      return 'globe';
    default:
      return 'computer';
  }
}
