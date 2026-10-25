import { describe, expect, it } from 'vitest';
import { looksLikePrUrl, prUrlHost } from './prUrl';

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
  it('rejects links to a host that is off', () => {
    const githubOnly = (h: string) => h === 'github';
    expect(
      looksLikePrUrl('https://gitlab.com/g/p/-/merge_requests/3', githubOnly),
    ).toBe(false);
    expect(
      looksLikePrUrl(
        'https://bitbucket.org/ws/repo/pull-requests/5',
        githubOnly,
      ),
    ).toBe(false);
    expect(looksLikePrUrl('https://github.com/o/r/pull/1', githubOnly)).toBe(
      true,
    );
    expect(looksLikePrUrl('o/r#4', githubOnly)).toBe(true);
  });
});

describe('prUrlHost', () => {
  it('names the host of each link shape', () => {
    expect(prUrlHost('https://github.com/o/r/pull/12')).toBe('github');
    expect(prUrlHost('o/r#4')).toBe('github');
    expect(prUrlHost('https://gitlab.com/g/p/-/merge_requests/3')).toBe(
      'gitlab',
    );
    expect(prUrlHost('https://bitbucket.org/ws/repo/pull-requests/5')).toBe(
      'bitbucket',
    );
    expect(prUrlHost('hello')).toBe(null);
  });
});
