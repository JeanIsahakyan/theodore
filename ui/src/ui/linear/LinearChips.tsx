/** Chips for the Linear issues linked to a PR ("ABC-123 · In Progress"),
 *  shared by Peek and the Review header. Clicking one opens the issue on
 *  linear.app; nothing here writes anything back. */
import { openExternal } from '../../core/openExternal';
import { Chip, Tooltip } from '@heroui/react';
import type { LinearIssue, PrId } from '../../gen/contract';
import { useLinearIssues } from './useLinearIssues';

/** Linear's `WorkflowState.type` buckets, coarsened to the chip's color. */
const STATE_COLOR: Record<string, 'default' | 'success' | 'danger'> = {
  completed: 'success',
  canceled: 'danger',
};

/** Pure so the mapping is unit-testable without mounting a chip. */
export function chipColorFor(
  stateType: string,
): 'default' | 'success' | 'danger' {
  return STATE_COLOR[stateType] ?? 'default';
}

function LinearChip({ issue }: { issue: LinearIssue }) {
  return (
    <Tooltip>
      <Chip
        size="sm"
        variant="secondary"
        color={chipColorFor(issue.state_type)}
        className="lin shrink-0 cursor-pointer gap-1 whitespace-nowrap"
        onClick={() => openExternal(issue.url)}
      >
        {issue.identifier} · {issue.state_name}
      </Chip>
      <Tooltip.Content>{issue.title}</Tooltip.Content>
    </Tooltip>
  );
}

export function LinearChips({ pr }: { pr: PrId }) {
  const issues = useLinearIssues(pr);
  if (!issues.length) return null;
  return (
    <>
      {issues.map((issue) => (
        <LinearChip key={issue.identifier} issue={issue} />
      ))}
    </>
  );
}
