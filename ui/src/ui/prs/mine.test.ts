import { describe, expect, it } from 'vitest';
import type { PrSummary } from '../../gen/contract';
import { gatesFor, nextStep } from './mine';

const summary = (over: Partial<PrSummary> = {}): PrSummary => ({
  pr: {
    repo: { host: 'github', owner: 'acme', name: 'web' },
    number: 1,
    host_id: null,
  },
  title: 'a change',
  author: { login: 'me', name: null, avatar_url: null },
  state: 'open',
  base_ref: 'main',
  head_ref: 'feature',
  head_sha: 'abc',
  additions: 1,
  deletions: 1,
  changed_files: 1,
  reasons: [],
  checks: 'pass',
  approvals: 1,
  required_approvals: 1,
  updated_at: 0,
  url: 'https://github.com/acme/web/pull/1',
  review_decision: null,
  conflicts: false,
  ...over,
});

describe('nextStep', () => {
  it('is "merged" / "closed" / "draft" straight off state', () => {
    expect(nextStep(summary({ state: 'merged' }))).toBe('merged');
    expect(nextStep(summary({ state: 'closed' }))).toBe('closed');
    expect(nextStep(summary({ state: 'draft' }))).toBe('draft');
  });

  it('is "merge" when every gate is green', () => {
    expect(nextStep(summary())).toBe('merge');
  });

  it('is "yours" when checks are failing', () => {
    expect(nextStep(summary({ checks: 'fail' }))).toBe('yours');
  });

  it('is "yours" when there are conflicts with the base branch', () => {
    expect(nextStep(summary({ conflicts: true }))).toBe('yours');
  });

  it('is "yours" when changes were requested', () => {
    expect(nextStep(summary({ review_decision: 'changes_requested' }))).toBe(
      'yours',
    );
  });

  it('is "waiting" when approvals are still needed but nothing is on the author', () => {
    expect(nextStep(summary({ approvals: 0, required_approvals: 1 }))).toBe(
      'waiting',
    );
  });
});

describe('gatesFor', () => {
  it('has no blockers when checks pass and approvals are met', () => {
    expect(gatesFor(summary()).every((g) => g.ok)).toBe(true);
  });

  it('flags failing checks', () => {
    const gates = gatesFor(summary({ checks: 'fail' }));
    expect(gates.find((g) => g.label === 'checks failing')?.ok).toBe(false);
  });

  it('flags missing approvals', () => {
    const gates = gatesFor(summary({ approvals: 0, required_approvals: 2 }));
    expect(gates.find((g) => g.label === '0/2 approvals')?.ok).toBe(false);
  });

  it('flags changes requested', () => {
    const gates = gatesFor(summary({ review_decision: 'changes_requested' }));
    expect(gates.find((g) => g.label === 'changes requested')?.ok).toBe(false);
  });

  it('flags conflicts with the base branch', () => {
    const gates = gatesFor(summary({ conflicts: true }));
    expect(gates.find((g) => g.label === 'conflicts with base')?.ok).toBe(
      false,
    );
  });
});

describe('gates of a PR that is not mergeable yet', () => {
  it('a draft or running checks never read as ready to merge', () => {
    const base = {
      checks: 'pass',
      approvals: 1,
      required_approvals: 1,
      review_decision: null,
      conflicts: false,
      state: 'open',
    } as unknown as Parameters<typeof gatesFor>[0];
    expect(gatesFor(base).every((g) => g.ok)).toBe(true);
    expect(gatesFor({ ...base, state: 'draft' }).some((g) => !g.ok)).toBe(true);
    expect(
      gatesFor({ ...base, checks: 'pending' }).find((g) => !g.ok)?.label,
    ).toBe('checks running');
  });
});
