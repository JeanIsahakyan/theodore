import { describe, expect, it } from 'vitest';
import { tourNextIndex, tourPrevIndex, tourStartIndex } from './tour';

describe('tourStartIndex', () => {
  it('starts at the first unread group', () => {
    expect(tourStartIndex([true, true, false, false])).toBe(2);
  });

  it('starts at 0 when nothing is read', () => {
    expect(tourStartIndex([false, false])).toBe(0);
  });

  it('restarts at 0 once everything is read', () => {
    expect(tourStartIndex([true, true, true])).toBe(0);
  });

  it('starts at 0 for an empty tour', () => {
    expect(tourStartIndex([])).toBe(0);
  });
});

describe('tourNextIndex', () => {
  it('advances by one', () => {
    expect(tourNextIndex(0, 3)).toBe(1);
  });

  it('ends the tour past the last group', () => {
    expect(tourNextIndex(2, 3)).toBeNull();
  });
});

describe('tourPrevIndex', () => {
  it('steps back by one', () => {
    expect(tourPrevIndex(2)).toBe(1);
  });

  it('is disabled at the first group', () => {
    expect(tourPrevIndex(0)).toBeNull();
  });
});
