import type { PrState, TaskStatus } from '../gen/contract';

const R = 5.5;
const C = 2 * Math.PI * R;

/** Linear-style status ring: outline + pie that fills with progress. */
function Ring({
  color,
  fill = 0,
  dashed,
  check,
  cross,
  title,
}: {
  color: string;
  fill?: number;
  dashed?: boolean;
  check?: boolean;
  cross?: boolean;
  title: string;
}) {
  return (
    <svg
      className="sicon"
      width="14"
      height="14"
      viewBox="0 0 14 14"
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

export const prStatusLabel: Record<PrState, string> = {
  draft: 'Draft',
  open: 'Open',
  merged: 'Merged',
  closed: 'Closed',
};

export function PRIcon({
  status,
  progress = 0,
}: {
  status: PrState;
  progress?: number;
}) {
  const t = prStatusLabel[status];
  switch (status) {
    case 'draft':
      return <Ring color="var(--muted)" dashed title={t} />;
    case 'open':
      return (
        <Ring
          color="var(--accent)"
          fill={progress}
          title={`${t}${progress ? ` · read ${Math.round(progress * 100)}%` : ''}`}
        />
      );
    case 'merged':
      return <Ring color="var(--accent)" check title={t} />;
    case 'closed':
      return <Ring color="var(--muted)" cross title={t} />;
  }
}

export const taskLabel: Record<TaskStatus, string> = {
  todo: 'Todo',
  progress: 'In progress',
  review: 'To verify',
  done: 'Done',
};

export function TaskIcon({ status }: { status: TaskStatus }) {
  const t = taskLabel[status];
  if (status === 'todo') return <Ring color="var(--muted)" title={t} />;
  if (status === 'progress')
    return <Ring color="var(--warning)" fill={0.5} title={t} />;
  if (status === 'review')
    return <Ring color="var(--accent)" fill={0.75} title={t} />;
  return <Ring color="var(--accent)" check title={t} />;
}
