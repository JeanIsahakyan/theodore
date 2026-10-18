/** Loading placeholders: shimmering shapes in the layout of what's coming. */
import { Skeleton } from '@heroui/react';
import { Sparkles } from '@gravity-ui/icons';

const W = ['w-11/12', 'w-3/4', 'w-5/6', 'w-2/3', 'w-4/5', 'w-1/2'];

/** Grouped list while the agent groups the PR. */
export function GroupsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-4 px-2 py-3" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex gap-3" style={{ opacity: 1 - i * 0.12 }}>
          <Skeleton
            animationType="shimmer"
            className="size-7 shrink-0 rounded-full"
          />
          <div className="flex flex-1 flex-col gap-2 pt-1">
            <Skeleton
              animationType="shimmer"
              className={`h-3.5 rounded-md ${W[i % W.length]}`}
            />
            <Skeleton
              animationType="shimmer"
              className="h-3 w-1/3 rounded-md"
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** A diff file card while its revision loads. */
export function DiffSkeleton({ files = 2 }: { files?: number }) {
  return (
    <div className="flex flex-col gap-5 p-5" aria-hidden>
      {Array.from({ length: files }, (_, f) => (
        <div
          key={f}
          className="overflow-hidden rounded-2xl border border-separator"
        >
          <div className="flex items-center gap-3 border-b border-separator px-4 py-3">
            <Skeleton animationType="shimmer" className="size-4 rounded" />
            <Skeleton
              animationType="shimmer"
              className="h-3.5 w-64 rounded-md"
            />
            <span className="flex-1" />
            <Skeleton animationType="shimmer" className="h-6 w-20 rounded-lg" />
          </div>
          <div className="flex flex-col gap-2 px-4 py-3">
            {Array.from({ length: 9 }, (_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton animationType="shimmer" className="h-3 w-6 rounded" />
                <Skeleton animationType="shimmer" className="h-3 w-6 rounded" />
                <Skeleton
                  animationType="shimmer"
                  className={`h-3 rounded ${W[(i + f) % W.length]}`}
                />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** List rows (inbox, tasks) while they load. */
export function RowsSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="flex flex-col" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 border-b border-separator px-5 py-3"
          style={{ opacity: 1 - i * 0.15 }}
        >
          <Skeleton animationType="shimmer" className="size-4 rounded-full" />
          <Skeleton
            animationType="shimmer"
            className={`h-3.5 rounded-md ${W[i % W.length]}`}
          />
          <span className="flex-1" />
          <Skeleton animationType="shimmer" className="h-3 w-16 rounded-md" />
        </div>
      ))}
    </div>
  );
}

/** Agent working on something long: a pulsing sparkle and a line of text. */
export function AgentWorking({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted">
      <Sparkles className="size-4 animate-pulse text-accent" />
      <span className="shimmer-text">{text}</span>
    </div>
  );
}
