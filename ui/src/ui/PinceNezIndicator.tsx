import { useId } from 'react';
import './pince-nez-indicator.css';

/**
 * The agent's animated turn indicator, without eyes: accent-tinted glass lenses, a rim
 * and a bridge, no plate. The state is the animation of the glass itself.
 */

export type PinceNezState =
  | 'idle' // resting, still
  | 'turn' // your turn: a soft pulse
  | 'thinking' // thinking: the lenses brighten in turn
  | 'reading' // reading code: stripes run up
  | 'writing' // writing: lines type in
  | 'loading' // loading, a tool call: arcs spin
  | 'done' // done: a pop and a sweep, once
  | 'error'; // error: a shudder and a red flash, once

export const PINCE_NEZ_LABELS: Record<PinceNezState, string> = {
  idle: 'Ready',
  turn: 'Your turn',
  thinking: 'Agent is thinking',
  reading: 'Agent is reading code',
  writing: 'Agent is writing',
  loading: 'Loading',
  done: 'Done',
  error: 'Error',
};

export interface PinceNezIndicatorProps {
  state?: PinceNezState;
  /** Side of the square in px; tested 16-96. 20 is the status-line size. */
  size?: number;
  /** done / error: repeat instead of playing once. */
  loop?: boolean;
  /** For a screen reader; defaults to `PINCE_NEZ_LABELS`. */
  label?: string;
  /** Hidden from a screen reader: visible status text is beside it. */
  decorative?: boolean;
  className?: string;
}

/** Thicker lines at small sizes, or they vanish. The arcs sit on the rim: at
 *  the smallest they stand out from it by being wider (and darker: CSS). */
function strokeTier(size: number) {
  if (size <= 18) return { rim: 36, stripe: 70, spin: 64, small: true };
  if (size <= 24) return { rim: 36, stripe: 70, spin: 36, small: false };
  if (size <= 40) return { rim: 26, stripe: 56, spin: 26, small: false };
  return { rim: 18, stripe: 44, spin: 18, small: false };
}

export function PinceNezIndicator({
  state = 'idle',
  size = 20,
  loop = false,
  label,
  decorative = false,
  className,
}: PinceNezIndicatorProps) {
  const uid = useId().replace(/:/g, '');
  const glassId = `pn-glass-${uid}`;
  const sweepId = `pn-sweep-${uid}`;
  const clipId = `pn-clip-${uid}`;
  const { rim, stripe, spin, small } = strokeTier(size);

  const a11y = decorative
    ? { 'aria-hidden': true as const }
    : { role: 'img', 'aria-label': label ?? PINCE_NEZ_LABELS[state] };

  return (
    <span
      className={className ? `pn ${className}` : 'pn'}
      data-state={state}
      data-loop={loop ? '' : undefined}
      data-small={small ? '' : undefined}
      style={{ width: size, height: size }}
      {...a11y}
    >
      {/* key: a new SVG on every state change, so done / error start over */}
      <svg
        key={state}
        viewBox="190 180 644 644"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <linearGradient id={glassId} x1="0" y1="0" x2="0.3" y2="1">
            <stop className="pn-stop-a" offset="0" />
            <stop className="pn-stop-b" offset="1" />
          </linearGradient>
          <linearGradient id={sweepId} x1="0" y1="0" x2="1" y2="0">
            <stop className="pn-sweep-edge" offset="0" />
            <stop className="pn-sweep-mid" offset="0.5" />
            <stop className="pn-sweep-edge" offset="1" />
          </linearGradient>
          <clipPath id={clipId}>
            <circle cx="352" cy="500" r="150" />
            <circle cx="672" cy="500" r="150" />
          </clipPath>
        </defs>

        <g className="pn-lenses">
          {/* glass */}
          <circle
            className="pn-glass-l"
            cx="352"
            cy="500"
            r="150"
            fill={`url(#${glassId})`}
          />
          <circle
            className="pn-glass-r"
            cx="672"
            cy="500"
            r="150"
            fill={`url(#${glassId})`}
          />

          {/* everything inside the lenses */}
          <g clipPath={`url(#${clipId})`}>
            <g className="pn-stripes" strokeWidth={stripe}>
              <path d="M100 330 L 924 330" />
              <path d="M100 440 L 924 440" />
              <path d="M100 550 L 924 550" />
              <path d="M100 660 L 924 660" />
              <path d="M100 770 L 924 770" />
            </g>
            <g className="pn-typing" strokeWidth={stripe}>
              <path className="pn-t1" d="M262 450 L 442 450" />
              <path className="pn-t2" d="M262 550 L 402 550" />
              <path className="pn-t1" d="M582 450 L 762 450" />
              <path className="pn-t2" d="M582 550 L 722 550" />
            </g>
            <rect
              className="pn-tint"
              x="100"
              y="300"
              width="824"
              height="420"
            />
            <rect
              className="pn-sweep"
              x="300"
              y="300"
              width="200"
              height="420"
              fill={`url(#${sweepId})`}
              transform="translate(-620 0)"
            />
          </g>

          {/* rim */}
          <g className="pn-rim" strokeWidth={rim}>
            <circle cx="352" cy="500" r="150" />
            <circle cx="672" cy="500" r="150" />
          </g>

          {/* loading arcs over the rim */}
          <g className="pn-spin" strokeWidth={spin}>
            <circle className="pn-spin-l" cx="352" cy="500" r="150" />
            <circle className="pn-spin-r" cx="672" cy="500" r="150" />
          </g>

          {/* bridge */}
          <path
            className="pn-bridge"
            strokeWidth={rim}
            d="M500 486 C 506 456, 518 456, 524 486"
          />
        </g>
      </svg>
    </span>
  );
}

export default PinceNezIndicator;
