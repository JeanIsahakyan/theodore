import { describe, expect, it } from 'vitest';

import { parseIssueRef, parsePrRef, startFooter } from './newSpaceStart';

describe('parsePrRef', () => {
  it('takes #n, n, and a PR URL from any host, tab or query included', () => {
    expect(parsePrRef('#15')).toBe(15);
    expect(parsePrRef(' 15 ')).toBe(15);
    expect(parsePrRef('https://github.com/acme/app/pull/15')).toBe(15);
    expect(parsePrRef('https://github.com/acme/app/pull/15/files?w=1')).toBe(
      15,
    );
    expect(parsePrRef('https://gitlab.com/acme/app/-/merge_requests/42')).toBe(
      42,
    );
    expect(
      parsePrRef('https://bitbucket.org/acme/app/pull-requests/7/overview'),
    ).toBe(7);
  });

  it('refuses anything else, an issue URL too', () => {
    expect(parsePrRef('')).toBeNull();
    expect(parsePrRef('abc')).toBeNull();
    expect(parsePrRef('#0')).toBeNull();
    expect(parsePrRef('https://github.com/acme/app/issues/15')).toBeNull();
    expect(parsePrRef('https://github.com/acme/app/pulls')).toBeNull();
  });
});

describe('parseIssueRef', () => {
  it('takes a pasted URL, #n or a bare number', () => {
    expect(parseIssueRef('https://github.com/acme/widgets/issues/123')).toBe(
      123,
    );
    expect(parseIssueRef('https://gitlab.com/acme/w/-/issues/42/?x=1')).toBe(
      42,
    );
    expect(parseIssueRef('#7')).toBe(7);
    expect(parseIssueRef('  9 ')).toBe(9);
  });

  it('refuses anything else', () => {
    expect(parseIssueRef('')).toBeNull();
    expect(parseIssueRef('fix the login')).toBeNull();
    expect(parseIssueRef('#0')).toBeNull();
    expect(parseIssueRef('https://github.com/acme/widgets/issues')).toBeNull();
  });
});

describe('startFooter', () => {
  it("doesn't tell an issue the branch/PR story", () => {
    const issue = startFooter('issue', 'main');
    expect(issue).not.toMatch(/tip|same branch/);
    expect(issue).toBe(
      'A new branch off main; the PR it opens closes the issue.',
    );
  });

  it('keeps the branch and PR lines their own', () => {
    expect(startFooter('branch')).toMatch(/pushes back to the same branch/);
    expect(startFooter('pr')).toMatch(/same PR/);
    expect(startFooter('goal')).toMatch(/never touched/);
  });
});
