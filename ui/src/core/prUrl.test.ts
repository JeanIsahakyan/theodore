import { describe, expect, it } from 'vitest';
import { looksLikePrUrl } from './prUrl';

describe('looksLikePrUrl', () => {
  it('accepts GitHub, GitLab, Bitbucket and shorthand refs', () => {
    expect(looksLikePrUrl('https://github.com/o/r/pull/12')).toBe(true);
    expect(looksLikePrUrl('https://github.com/o/r/pull/12/files')).toBe(true);
    expect(looksLikePrUrl('https://gitlab.com/g/s/p/-/merge_requests/3')).toBe(
      true,
    );
    expect(
      looksLikePrUrl('https://bitbucket.org/ws/repo/pull-requests/5'),
    ).toBe(true);
    expect(looksLikePrUrl('o/r#4')).toBe(true);
  });
  it('rejects everything else', () => {
    expect(looksLikePrUrl('hello world')).toBe(false);
    expect(looksLikePrUrl('https://github.com/o/r')).toBe(false);
  });
});
