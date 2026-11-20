/** The small pieces every timeline row is built of (`TurnTimeline.tsx`,
 *  `SpaceToolRow.tsx`): the icon slot, the chevron, the failed mark, line
 *  counts. */
import type { ReactNode } from 'react';
import { ChevronRight, CircleXmarkFill } from '@gravity-ui/icons';
import { Spinner } from './bits';

export const ROW = 'flex min-w-0 items-center gap-1.5 text-[13px]';

export function StepIcon({
  busy,
  children,
}: {
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <span className="grid size-4 shrink-0 place-items-center text-muted">
      {busy ? <Spinner /> : children}
    </span>
  );
}

export function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronRight
      className={`size-3.5 shrink-0 text-muted ${open ? 'rotate-90' : ''}`}
    />
  );
}

export function Failed() {
  return (
    <span className="turn-tool-failed inline-flex shrink-0 items-center gap-1 text-xs text-danger">
      <CircleXmarkFill className="size-3.5" />
      failed
    </span>
  );
}

export function LineCounts({
  added,
  removed,
}: {
  added: number | null | undefined;
  removed: number | null | undefined;
}) {
  return (
    <>
      {added != null && (
        <span className="turn-added shrink-0 font-mono text-[11px] text-success">
          +{added}
        </span>
      )}
      {removed != null && (
        <span className="turn-removed shrink-0 font-mono text-[11px] text-danger">
          −{removed}
        </span>
      )}
    </>
  );
}
