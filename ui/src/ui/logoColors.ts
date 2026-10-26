/** The logo's three colours, one set per build so builds are told apart at
 *  a glance. The app icon uses the same sets: `scripts/icon-variant.sh`
 *  swaps the production colours in `apps/desktop/icons/src/icon.svg` for
 *  these, so keep the two in step. */
export interface LogoColors {
  /** The tile. */
  tile: string;
  /** The darker blobs drifting under the glass. */
  blob: string;
  /** The shadow under the lenses. */
  shadow: string;
}

export const LOGO_COLORS = {
  production: { tile: '#3F86D6', blob: '#0C5BC0', shadow: '#03306B' },
  staging: { tile: '#DE8435', blob: '#C05A0C', shadow: '#6D2D03' },
  nightly: { tile: '#8C56D2', blob: '#6120B6', shadow: '#320868' },
  dev: { tile: '#669980', blob: '#406D57', shadow: '#183929' },
} as const satisfies Record<string, LogoColors>;

export type LogoEnv = keyof typeof LOGO_COLORS;

/** The colours for `AppInfo.build_env`; production's before it's known
 *  (or for an env this UI doesn't know). */
export function logoColors(buildEnv: string | null | undefined): LogoColors {
  return Object.hasOwn(LOGO_COLORS, buildEnv ?? '')
    ? LOGO_COLORS[buildEnv as LogoEnv]
    : LOGO_COLORS.production;
}
