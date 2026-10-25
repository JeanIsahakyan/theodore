import { observer } from 'mobx-react-lite';
import { useId } from 'react';
import { useRootStoreOrNull } from '../stores/context';
import { logoColors, type LogoColors } from './logoColors';

/** Light drifting across the glass: each lens's stripes slide down one
 *  stripe pitch (110) and loop, the right lens half a beat behind. The
 *  stripe above the lenses scrolls in as the bottom one leaves, so the
 *  loop has no seam; at rest it's exactly the static art (the 220 stripe
 *  sits above the lenses, clipped away). */
const STRIPES = [220, 330, 440, 550, 660];
const LENSES = [352, 672];

/** This build's logo colours (`AppInfo.build_env`); production's until
 *  the app info arrives, or outside a store. Call it in an observer. */
export function useLogoColors(): LogoColors {
  return logoColors(useRootStoreOrNull()?.ephemeral.appInfo?.build_env);
}

/** The app mark as inline SVG: the glasses on a tile, the same art as the
 *  app icon (`apps/desktop/icons/src/icon.svg`) on its 1024 canvas, in the
 *  given colours. `animated` sets the refraction stripes drifting (the
 *  keyframes are in styles.css); `glint` sweeps one band of light across
 *  the glass. Ids are per instance, so several can share a page. */
export function LogoArt({
  colors,
  size,
  viewBox,
  className = '',
  animated = false,
  glint = false,
}: {
  colors: LogoColors;
  size: number;
  viewBox: string;
  className?: string;
  animated?: boolean;
  glint?: boolean;
}) {
  const id = `l${useId().replace(/[^\w-]/g, '')}`;
  return (
    <svg
      viewBox={viewBox}
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
        {glint && (
          <linearGradient id={`${id}-glint`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#FFFFFF" stopOpacity="0" />
            <stop offset="0.5" stopColor="#FFFFFF" stopOpacity="0.7" />
            <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
          </linearGradient>
        )}
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
        className="logo-tile"
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

      {/* shadow under the lenses */}
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

      {/* Refraction: the clip stays put, the stripes inside it move. */}
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
          {glint && (
            <rect
              className={`welcome-glint${i ? ' welcome-glint-late' : ''}`}
              x={cx - 260}
              y="300"
              width="120"
              height="400"
              fill={`url(#${id}-glint)`}
              transform={`rotate(20 ${cx} 500)`}
            />
          )}
        </g>
      ))}

      <g fill="none" stroke={`url(#${id}-rim)`} strokeWidth="6">
        {LENSES.map((cx) => (
          <circle key={cx} cx={cx} cy="500" r="150" />
        ))}
      </g>

      {/* bridge */}
      <path
        d="M500 486 C 506 456, 518 456, 524 486"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="20"
        strokeLinecap="round"
      />

      {/* highlights */}
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

/** The app mark: the glasses on a tile coloured by the build (blue in
 *  production; see `logoColors`). */
export const Logo = observer(function Logo({ size = 24 }: { size?: number }) {
  return (
    <LogoArt
      colors={useLogoColors()}
      size={size}
      viewBox="0 0 1024 1024"
      // The art has a 100px margin inside its 1024 canvas; scale it out so
      // the tile fills the box like the old square did.
      className="scale-[1.24]"
    />
  );
});
