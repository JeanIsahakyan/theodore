import { Chip } from '@heroui/react';
import type { PrSummary } from '../../gen/contract';
import { PrStatusIcon, prStatus } from '../StatusIcon';

/** One chip for where the PR stands — the same mark and word as
 *  everywhere else (`prStatus`), tinted by its tone. */
export function StatusChip({
  summary,
  progress,
  className = '',
}: {
  summary: PrSummary;
  progress: number;
  className?: string;
}) {
  const { tone, label } = prStatus(summary);
  const color =
    tone === 'problem'
      ? 'danger'
      : tone === 'pending'
        ? 'warning'
        : tone === 'ready'
          ? 'success'
          : 'default';
  return (
    <Chip
      size="sm"
      variant={color === 'default' ? 'secondary' : 'soft'}
      color={color}
      className={`gap-1.5 ${className}`}
    >
      <PrStatusIcon summary={summary} progress={progress} />
      {label}
    </Chip>
  );
}
