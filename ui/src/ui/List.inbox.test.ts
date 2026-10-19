import { describe, expect, it } from 'vitest';
import { inInbox } from './List';

describe('inInbox', () => {
  it('keeps open PRs with a reason and drops the rest', () => {
    expect(inInbox({ state: 'open', reasons: ['review_requested'] })).toBe(
      true,
    );
    expect(inInbox({ state: 'draft', reasons: ['authored'] })).toBe(true);
    expect(inInbox({ state: 'merged', reasons: ['authored'] })).toBe(false);
    expect(inInbox({ state: 'open', reasons: [] })).toBe(false);
  });
});
