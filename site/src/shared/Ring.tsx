/**
 * The desktop's status mark (`ui/src/ui/StatusIcon.tsx` `Ring`): an outline
 * that fills like a pie with progress, or a filled check / cross. Copied
 * without the PR rules around it.
 */
const R = 5.5;
const C = 2 * Math.PI * R;

export function Ring({
  color,
  fill = 0,
  dashed,
  check,
  cross,
  title,
  size = 14,
}: {
  color: string;
  fill?: number;
  dashed?: boolean;
  check?: boolean;
  cross?: boolean;
  title: string;
  size?: number;
}) {
  return (
    <svg
      className="shrink-0"
      width={size}
      height={size}
      viewBox="0 0 14 14"
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      {check ? (
        <>
          <circle cx="7" cy="7" r="6.5" fill={color} />
          <path
            d="M4.2 7.2l1.9 1.9 3.8-4"
            stroke="var(--surface)"
            strokeWidth="1.6"
            fill="none"
            strokeLinecap="round"
          />
        </>
      ) : cross ? (
        <>
          <circle cx="7" cy="7" r="6.5" fill={color} />
          <path
            d="M4.7 4.7l4.6 4.6M9.3 4.7l-4.6 4.6"
            stroke="var(--surface)"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </>
      ) : (
        <>
          <circle
            cx="7"
            cy="7"
            r="6"
            fill="none"
            stroke={color}
            strokeWidth="1.5"
            strokeDasharray={dashed ? '1.6 1.9' : undefined}
          />
          {fill > 0 && (
            <circle
              cx="7"
              cy="7"
              r={R / 2}
              fill="none"
              stroke={color}
              strokeWidth={R}
              strokeDasharray={`${(C / 2) * fill} ${C}`}
              transform="rotate(-90 7 7)"
            />
          )}
        </>
      )}
    </svg>
  );
}
