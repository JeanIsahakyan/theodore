import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';

/** The whole welcome, start to finish: the logo holds for a beat, then
 *  zooms through while the app fades in (keyframes in styles.css). */
export const WELCOME_MS = 1650;

/** Light drifting across the glass: each lens's stripes slide down one
 *  stripe pitch (110) and loop, the right lens half a beat behind. The
 *  stripe above the lenses scrolls in as the bottom one leaves, so the
 *  loop has no seam; at rest it's exactly the static art. */
const STRIPES = [220, 330, 440, 550, 660];
const LENSES = [352, 672];

/** The app mark as inline SVG (same art as `assets/logo.svg`, cropped to
 *  the tile) with the refraction stripes moving. Ids are per instance, so
 *  several can share a page. */
export function WelcomeLogo({
  size,
  className = '',
  glint = false,
}: {
  size: number;
  className?: string;
  /** One soft band of light sweeps across the glass as it appears. */
  glint?: boolean;
}) {
  const id = `w${useId().replace(/[^\w-]/g, '')}`;
  return (
    <svg
      viewBox="96 96 832 832"
      width={size}
      height={size}
      aria-hidden
      className={`welcome-logo shrink-0 select-none ${className}`}
    >
      <defs>
        <radialGradient id={`${id}-blob`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#0C5BC0" stopOpacity="0.95" />
          <stop offset="1" stopColor="#0C5BC0" stopOpacity="0" />
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
        <linearGradient id={`${id}-glint`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0" />
          <stop offset="0.5" stopColor="#FFFFFF" stopOpacity="0.7" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
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

      <rect x="100" y="100" width="824" height="824" rx="185" fill="#3F86D6" />
      <g clipPath={`url(#${id}-tile)`}>
        <circle cx="300" cy="330" r="300" fill={`url(#${id}-blob)`} />
        <circle cx="740" cy="380" r="320" fill={`url(#${id}-blob)`} />
        <circle cx="520" cy="800" r="330" fill={`url(#${id}-blob)`} />
      </g>

      {/* shadow under the lenses */}
      <g fill="#03306B" fillOpacity="0.18" transform="translate(0 26)">
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
            className={`welcome-stripes${i ? ' welcome-stripes-late' : ''}`}
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

/** Motion is on, and something will actually run it: not with reduced
 *  motion, and not under jsdom (no Web Animations API), so tests never
 *  wait on the welcome. */
function canAnimate(): boolean {
  if (typeof matchMedia === 'undefined') return false;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  return typeof document.documentElement.animate === 'function';
}

/** True for `WELCOME_MS` right after onboarding finishes in this window.
 *  An app that starts onboarded never plays it, so it's once per install
 *  (or per "Reset onboarding"). */
export function useWelcome(onboarded: boolean): boolean {
  const [was, setWas] = useState(onboarded);
  const [playing, setPlaying] = useState(false);
  // Set during render, not in an effect: the app's first frame already
  // has the logo over it, never a flash of the bare shell.
  if (was !== onboarded) {
    setWas(onboarded);
    setPlaying(onboarded && canAnimate());
  }
  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => setPlaying(false), WELCOME_MS);
    return () => clearTimeout(t);
  }, [playing]);
  return playing;
}

/** The logo alone on a blank page, then *whoosh*: it zooms through and
 *  the page clears to the app (which `.app-enter` brings in). Portalled
 *  out of the shell, so the shell's own fade-in doesn't fade it too. */
export function Welcome() {
  return createPortal(
    <div className="welcome fixed inset-0 z-[100] grid place-items-center bg-background">
      <div className="welcome-glow" aria-hidden />
      <WelcomeLogo size={168} glint className="welcome-zoom" />
    </div>,
    document.body,
  );
}
