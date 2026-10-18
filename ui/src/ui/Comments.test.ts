import { describe, expect, it } from 'vitest';
import type { PrSummary } from '../gen/contract';
import { canCommitSuggestions, suggestionOf } from './Comments';

describe('suggestionOf', () => {
  it('returns null for a comment with no suggestion fence', () => {
    expect(suggestionOf('just a regular comment')).toBeNull();
  });

  it('extracts the suggested lines from a ```suggestion fence', () => {
    expect(suggestionOf('fix this:\n```suggestion\nconst x = 1;\n```')).toEqual(
      ['const x = 1;'],
    );
  });

  it('extracts every line of a multi-line suggestion', () => {
    const body = '```suggestion\nline one\nline two\n```\ntrailing note';
    expect(suggestionOf(body)).toEqual(['line one', 'line two']);
  });
});

const summary = (over: Partial<PrSummary> = {}): PrSummary =>
  ({
    pr: {
      repo: { host: 'github', owner: 'acme', name: 'web' },
      number: 1,
      host_id: null,
    },
    title: 'a change',
    author: { login: 'author', name: null, avatar_url: null },
    state: 'open',
    base_ref: 'main',
    head_ref: 'feature',
    head_sha: 'abc',
    additions: 1,
    deletions: 1,
    changed_files: 1,
    reasons: [],
    checks: 'none',
    approvals: 0,
    required_approvals: null,
    updated_at: 0,
    url: 'https://github.com/acme/web/pull/1',
    ...over,
  }) as PrSummary;

describe('canCommitSuggestions', () => {
  it('is false with no summary loaded yet', () => {
    expect(canCommitSuggestions(undefined, 'author')).toBe(false);
  });

  it('is true for a local branch regardless of viewer', () => {
    const local = summary({
      pr: {
        repo: { host: 'local', owner: '', name: 'web' },
        number: 0,
        host_id: null,
      },
    });
    expect(canCommitSuggestions(local, undefined)).toBe(true);
  });

  it('is true when the viewer authored the PR', () => {
    expect(canCommitSuggestions(summary(), 'author')).toBe(true);
  });

  it('is false for someone else’s PR', () => {
    expect(canCommitSuggestions(summary(), 'someone-else')).toBe(false);
  });

  it('is false with no signed-in viewer on a host PR', () => {
    expect(canCommitSuggestions(summary(), undefined)).toBe(false);
  });
});
