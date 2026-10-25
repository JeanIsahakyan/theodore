import { Chip } from '@heroui/react';
import type { PrSummary } from '../../gen/contract';
import { PRIcon, PrStatusIcon, prProblems, prStatusLabel } from '../StatusIcon';

/** One chip for where the PR stands: what's wrong with it in red
 *  (`prProblems`), otherwise its state with the read progress. */
export function StatusChip({
  summary,
  progress,
  className = '',
}: {
  summary: PrSummary;
  progress: number;
  className?: string;
}) {
  const problems = prProblems(summary);
  if (problems.length) {
    return (
      <Chip
        size="sm"
        variant="soft"
        color="danger"
        className={`gap-1.5 ${className}`}
      >
        <PrStatusIcon summary={summary} />
        {problems.join(' · ')}
      </Chip>
    );
  }
  return (
    <Chip size="sm" variant="secondary" className={`gap-1.5 ${className}`}>
      <PRIcon status={summary.state} progress={progress} />
      {prStatusLabel[summary.state]}
    </Chip>
  );
}
