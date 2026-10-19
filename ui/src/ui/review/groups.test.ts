import { describe, expect, it } from 'vitest';
import type { Group } from '../../gen/contract';
import {
  groupsInRevision,
  nextReviewableGroup,
  prevReviewableGroup,
  reviewableGroups,
} from './groups';

const group = (over: Partial<Group> & { id: string }): Group => ({
  title: over.id,
  why: '',
  kind: 'normal',
  risk: null,
  check: [],
  hunks: [],
  outliers: [],
  ...over,
});

describe('groupsInRevision', () => {
  it('keeps a group whose hunks are part of the revision', () => {
    const g = group({ id: 'g1', hunks: ['h1', 'h2'] });
    expect(groupsInRevision([g], new Set(['h2']))).toEqual([g]);
  });

  it('drops a group with none of its hunks in the revision', () => {
    const g = group({ id: 'g1', hunks: ['h1'] });
    expect(groupsInRevision([g], new Set(['h9']))).toEqual([]);
  });

  it('keeps a hidden group — GroupsPane still lists it, collapsed', () => {
    const g = group({ id: 'g1', kind: 'hidden', hunks: ['h1'] });
    expect(groupsInRevision([g], new Set(['h1']))).toEqual([g]);
  });
});

describe('reviewableGroups', () => {
  it('drops hidden groups, keeps normal and skim', () => {
    const groups = [
      group({ id: 'g1', kind: 'normal' }),
      group({ id: 'g2', kind: 'hidden' }),
      group({ id: 'g3', kind: 'skim' }),
    ];
    expect(reviewableGroups(groups).map((g) => g.id)).toEqual(['g1', 'g3']);
  });
});

describe('nextReviewableGroup / prevReviewableGroup', () => {
  const groups = [
    group({ id: 'g1', kind: 'normal' }),
    group({ id: 'g2', kind: 'hidden' }),
    group({ id: 'g3', kind: 'normal' }),
    group({ id: 'g4', kind: 'hidden' }),
  ];

  it('skips a hidden group immediately after the current one', () => {
    expect(nextReviewableGroup(groups, 'g1')?.id).toBe('g3');
  });

  it('returns null past the last reviewable group', () => {
    expect(nextReviewableGroup(groups, 'g3')).toBeNull();
  });

  it('finds the next group even when starting from a hidden one', () => {
    expect(nextReviewableGroup(groups, 'g2')?.id).toBe('g3');
  });

  it('returns null when there is no current id (not found at -1)', () => {
    expect(nextReviewableGroup(groups, null)?.id).toBe('g1');
  });

  it('steps backward, skipping hidden groups', () => {
    expect(prevReviewableGroup(groups, 'g3')?.id).toBe('g1');
  });

  it('returns null before the first reviewable group', () => {
    expect(prevReviewableGroup(groups, 'g1')).toBeNull();
  });
});
