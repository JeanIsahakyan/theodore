import { describe, expect, it } from 'vitest';
import { DEFAULT_DISPLAY, groupPRs, inInbox, type InboxPr } from './List';

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

describe('groupPRs by section', () => {
  const pr = (id: string, reasons: InboxPr['reasons'], updated_at = 1) =>
    ({ id, reasons, updated_at, additions: 0, deletions: 0 }) as InboxPr;

  it('lists each PR once, in the first section its reasons reach', () => {
    const groups = groupPRs(
      [
        pr('a', ['review_requested', 'mentioned'], 3),
        pr('b', ['mentioned'], 2),
        pr('c', ['team_review_requested'], 1),
      ],
      DEFAULT_DISPLAY,
    );
    const byId = Object.fromEntries(
      groups.map((g) => [g.id, g.items.map((p) => p.id)]),
    );
    expect(byId.review).toEqual(['a', 'c']);
    expect(byId.mentioned).toEqual(['b']);
    const all = groups.flatMap((g) => g.items.map((p) => p.id));
    expect(new Set(all).size).toBe(all.length);
  });
});
