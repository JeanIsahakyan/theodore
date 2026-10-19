/**
 * The sticky tour header: progress bar, one dot per group, Back/Next and
 * "step N of M" — ported from the prototype's `TourBar`, which Theodore had
 * simplified down to a single static banner line.
 */
import { Check } from '@gravity-ui/icons';
import { Button, ProgressBar, Surface, Toolbar } from '@heroui/react';
import type { Group } from '../../gen/contract';
import { Btn } from '../bits';

export function TourBar({
  groups,
  index,
  onBack,
  onNext,
}: {
  groups: Group[];
  index: number;
  onBack: () => void;
  onNext: () => void;
}) {
  const g = groups[index];
  if (!g) return null;
  return (
    <Surface className="tour sticky -top-5 z-[3] -mx-6 -mt-5 mb-5 flex items-center gap-3 border-b border-separator px-6 py-3">
      <ProgressBar
        aria-label="Tour"
        value={index}
        maxValue={groups.length}
        size="sm"
        className="w-28"
      >
        <ProgressBar.Track>
          <ProgressBar.Fill />
        </ProgressBar.Track>
      </ProgressBar>
      <div className="tour-dots flex gap-1">
        {groups.map((x, i) => (
          <span
            key={x.id}
            className={
              i < index
                ? 'text-success'
                : i === index
                  ? 'font-bold text-accent'
                  : 'text-muted'
            }
          >
            {i + 1}
          </span>
        ))}
      </div>
      <div className="flex-1">
        Tour · step {index + 1} of {groups.length} · <b>{g.title}</b>
        {g.kind === 'skim' && (
          <span className="text-muted"> — skim quickly</span>
        )}
      </div>
      <Toolbar aria-label="Tour" className="flex gap-1.5">
        <Button
          size="sm"
          variant="tertiary"
          isDisabled={index === 0}
          onPress={onBack}
        >
          ← back
        </Button>
        <Btn tone="primary" kbd="R" icon={<Check />} onPress={onNext}>
          {index === groups.length - 1 ? 'Read, to review' : 'Read, next'}
        </Btn>
      </Toolbar>
    </Surface>
  );
}
