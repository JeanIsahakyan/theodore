/**
 * The "Mine" filter's grouping: your own PRs by what happens next —
 * computed from `PrSummary` alone (no per-row `merge_info` fetch): checks,
 * approvals, `review_decision` and `conflicts` are all on the summary.
 */
import type { PrSummary } from '../../gen/contract';

export type Step =
  'merge' | 'yours' | 'waiting' | 'draft' | 'merged' | 'closed';

export const STEPS: { id: Step; title: string }[] = [
  { id: 'merge', title: 'Ready to merge' },
  { id: 'yours', title: 'Your move' },
  { id: 'waiting', title: 'Waiting on reviewers' },
  { id: 'draft', title: 'Drafts' },
  { id: 'merged', title: 'Merged' },
  { id: 'closed', title: 'Closed' },
];

export interface Gate {
  ok: boolean;
  label: string;
}

/** The merge gates a PR summary alone can answer, without `merge_info`. */
export function gatesFor(p: PrSummary): Gate[] {
  const gates: Gate[] = [
    {
      ok: p.checks !== 'fail',
      label:
        p.checks === 'fail'
          ? 'checks failing'
          : p.checks === 'pending'
            ? 'checks running'
            : 'checks passing',
    },
  ];
  if (p.required_approvals != null) {
    gates.push({
      ok: p.approvals >= p.required_approvals,
      label: `${p.approvals}/${p.required_approvals} approvals`,
    });
  }
  if (p.review_decision === 'changes_requested') {
    gates.push({ ok: false, label: 'changes requested' });
  }
  if (p.conflicts) {
    gates.push({ ok: false, label: 'conflicts with base' });
  }
  return gates;
}

export function nextStep(p: PrSummary): Step {
  if (p.state === 'merged') return 'merged';
  if (p.state === 'closed') return 'closed';
  if (p.state === 'draft') return 'draft';
  const blocked = gatesFor(p).some((g) => !g.ok);
  if (!blocked) return 'merge';
  const yours =
    p.checks === 'fail' ||
    p.conflicts ||
    p.review_decision === 'changes_requested';
  return yours ? 'yours' : 'waiting';
}
