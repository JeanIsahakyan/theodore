import { describe, expect, it } from 'vitest';
import type { Group } from '../../gen/contract';
import {
  groupsInRevision,
  groupsProgress,
  nextReviewableGroup,
  nextUnreadGroup,
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
  it('keeps a group whose hunks are all part of the revision, as is', () => {
    const g = group({ id: 'g1', hunks: ['h1', 'h2'] });
    expect(groupsInRevision([g], new Set(['h1', 'h2']))[0]).toBe(g);
  });

  it('drops hunks (and outliers) a push removed from the revision', () => {
    const g = group({ id: 'g1', hunks: ['h1', 'h2', 'h3'], outliers: ['h1'] });
    expect(groupsInRevision([g], new Set(['h2', 'h3']))).toEqual([
      { ...g, hunks: ['h2', 'h3'], outliers: [] },
    ]);
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

describe('nextUnreadGroup', () => {
  const groups = [
    group({ id: 'g1', kind: 'normal', hunks: ['h1'] }),
    group({ id: 'g2', kind: 'hidden', hunks: ['h2'] }),
    group({ id: 'g3', kind: 'normal', hunks: ['h3'] }),
    group({ id: 'g4', kind: 'normal', hunks: ['h4'] }),
  ];

  it('moves to the next group once the current one is read', () => {
    const read = new Set(['h1']);
    expect(nextUnreadGroup(groups, 'g1', read)?.id).toBe('g3');
  });

  it('skips a hidden group', () => {
    const read = new Set(['h1']);
    expect(nextUnreadGroup(groups, 'g1', read)?.id).not.toBe('g2');
  });

  it('skips a group that is already fully read', () => {
    const read = new Set(['h1', 'h3']);
    expect(nextUnreadGroup(groups, 'g1', read)?.id).toBe('g4');
  });

  it('returns null once nothing after the current group is unread', () => {
    const read = new Set(['h1', 'h3', 'h4']);
    expect(nextUnreadGroup(groups, 'g1', read)).toBeNull();
  });
});

describe('groupsProgress', () => {
  const groups = [
    group({ id: 'g1', kind: 'normal', hunks: ['h1', 'h2'] }),
    group({ id: 'g2', kind: 'hidden', hunks: ['h3'] }),
    group({ id: 'g3', kind: 'normal', hunks: ['h4'] }),
  ];

  it('counts reviewable groups only, each read once all its hunks are', () => {
    const read = new Set(['h1', 'h2']);
    expect(groupsProgress(groups, read)).toEqual({
      read: 1,
      total: 2,
      label: '1 of 2 groups read',
    });
  });

  it('reports all groups read once every reviewable group is fully read', () => {
    const read = new Set(['h1', 'h2', 'h4']);
    expect(groupsProgress(groups, read)).toEqual({
      read: 2,
      total: 2,
      label: 'All groups read',
    });
  });

  it('is "0 of N" when nothing is read yet', () => {
    const read = new Set<string>();
    expect(groupsProgress(groups, read).label).toBe('0 of 2 groups read');
  });

  it('singularizes "group" for a single reviewable group', () => {
    const one = [group({ id: 'g1', kind: 'normal', hunks: ['h1'] })];
    expect(groupsProgress(one, new Set<string>()).label).toBe(
      '0 of 1 group read',
    );
  });
});
