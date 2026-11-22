/**
 * The app mark, the same art as `ui/src/ui/Logo.tsx` (`LogoArt`) and the app
 * icon (`apps/desktop/icons/src/icon.svg`): the glasses on a tile, on its
 * 1024 canvas. Copied rather than imported: the desktop's `Logo` reads the
 * build from its MobX store, which the site has no use for. The colours
 * come from the desktop (`@desktop/ui/logoColors`), so the two never drift.
 */
import { useId } from 'react';
import { LOGO_COLORS, type LogoColors } from '@desktop/ui/logoColors';

const STRIPES = [220, 330, 440, 550, 660];
const LENSES = [352, 672];

export function LogoArt({
  colors = LOGO_COLORS.production,
  size,
  className = '',
  animated = false,
}: {
  colors?: LogoColors;
  size: number;
  className?: string;
  /** The refraction stripes drift (styles.css `welcome-stripes`). */
  animated?: boolean;
}) {
  const id = `l${useId().replace(/[^\w-]/g, '')}`;
  return (
    <svg
      // The art has a 100px margin inside its canvas; the site shows the
      // tile edge to edge.
      viewBox="100 100 824 824"
      width={size}
      height={size}
      aria-hidden
      className={`shrink-0 select-none ${className}`}
    >
      <defs>
        <radialGradient id={`${id}-blob`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor={colors.blob} stopOpacity="0.95" />
          <stop offset="1" stopColor={colors.blob} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-glass`} x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.72" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0.14" />
        </linearGradient>
        <linearGradient id={`${id}-rim`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="1" />
          <stop offset="0.5" stopColor="#FFFFFF" stopOpacity="0.25" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0.7" />
        </linearGradient>
        <clipPath id={`${id}-tile`}>
          <rect x="100" y="100" width="824" height="824" rx="185" />
        </clipPath>
        {LENSES.map((cx, i) => (
          <clipPath key={cx} id={`${id}-lens${i}`}>
            <circle cx={cx} cy="500" r="150" />
          </clipPath>
        ))}
      </defs>

      <rect
        x="100"
        y="100"
        width="824"
        height="824"
        rx="185"
        fill={colors.tile}
      />
      <g clipPath={`url(#${id}-tile)`}>
        <circle cx="300" cy="330" r="300" fill={`url(#${id}-blob)`} />
        <circle cx="740" cy="380" r="320" fill={`url(#${id}-blob)`} />
        <circle cx="520" cy="800" r="330" fill={`url(#${id}-blob)`} />
      </g>

      <g fill={colors.shadow} fillOpacity="0.18" transform="translate(0 26)">
        {LENSES.map((cx) => (
          <circle key={cx} cx={cx} cy="500" r="150" />
        ))}
      </g>

      {LENSES.map((cx) => (
        <circle
          key={cx}
          cx={cx}
          cy="500"
          r="150"
          fill={`url(#${id}-glass)`}
          fillOpacity="0.75"
        />
      ))}

      {LENSES.map((cx, i) => (
        <g key={cx} clipPath={`url(#${id}-lens${i})`}>
          <g
            className={
              animated
                ? `welcome-stripes${i ? ' welcome-stripes-late' : ''}`
                : undefined
            }
            stroke="#FFFFFF"
            strokeOpacity="0.45"
            strokeWidth="40"
          >
            {STRIPES.map((y) => (
              <path key={y} d={`M100 ${y} L 924 ${y}`} />
            ))}
          </g>
        </g>
      ))}

      <g fill="none" stroke={`url(#${id}-rim)`} strokeWidth="6">
        {LENSES.map((cx) => (
          <circle key={cx} cx={cx} cy="500" r="150" />
        ))}
      </g>

      <path
        d="M500 486 C 506 456, 518 456, 524 486"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="20"
        strokeLinecap="round"
      />

      <g fill="none" stroke="#FFFFFF" strokeWidth="12" strokeLinecap="round">
        <path d="M250 430 A 120 120 0 0 1 300 380" />
        <path d="M570 430 A 120 120 0 0 1 620 380" />
      </g>

      <rect
        x="100"
        y="100"
        width="824"
        height="824"
        rx="185"
        fill="none"
        stroke="#FFFFFF"
        strokeOpacity="0.6"
        strokeWidth="6"
      />
    </svg>
  );
}
