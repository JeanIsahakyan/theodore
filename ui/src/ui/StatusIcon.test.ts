import { describe, expect, it } from 'vitest';
import { prProblems } from './StatusIcon';

const pr = {
  state: 'open' as const,
  checks: 'pass' as const,
  conflicts: false,
  review_decision: null,
  base_ref: 'main',
};

describe('prProblems', () => {
  it('is empty for a healthy PR', () => {
    expect(prProblems(pr)).toEqual([]);
  });

  it('lists failing checks, conflicts and requested changes in that order', () => {
    expect(
      prProblems({
        ...pr,
        checks: 'fail',
        conflicts: true,
        review_decision: 'changes_requested',
      }),
    ).toEqual(['Checks failing', 'Conflicts with main', 'Changes requested']);
  });

  it('ignores merged and closed PRs', () => {
    expect(prProblems({ ...pr, state: 'merged', checks: 'fail' })).toEqual([]);
    expect(prProblems({ ...pr, state: 'closed', conflicts: true })).toEqual([]);
  });

  it('counts a draft too', () => {
    expect(prProblems({ ...pr, state: 'draft', checks: 'fail' })).toEqual([
      'Checks failing',
    ]);
  });
});
