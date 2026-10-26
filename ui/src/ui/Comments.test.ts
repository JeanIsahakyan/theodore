import { describe, expect, it } from 'vitest';
import type { PrSummary, ReactionCount } from '../gen/contract';
import { canCommitSuggestions, mergeReactions, suggestionOf } from './Comments';

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

const noOverride = () => undefined;

describe('mergeReactions', () => {
  it('reads server counts straight through with no override', () => {
    const server: ReactionCount[] = [
      { emoji: '+1', count: 3, viewer_reacted: false },
    ];
    const views = mergeReactions(server, noOverride);
    expect(views.find((v) => v.emoji === '+1')).toEqual({
      emoji: '+1',
      count: 3,
      mine: false,
    });
  });

  it('returns a zero-count row for an emoji with no server data', () => {
    const views = mergeReactions(undefined, noOverride);
    expect(views.every((v) => v.count === 0 && !v.mine)).toBe(true);
    expect(views).toHaveLength(8);
  });

  it('an optimistic "on" override adds 1 even before the server agrees', () => {
    const server: ReactionCount[] = [
      { emoji: 'heart', count: 2, viewer_reacted: false },
    ];
    const views = mergeReactions(server, (e) =>
      e === 'heart' ? true : undefined,
    );
    const heart = views.find((v) => v.emoji === 'heart')!;
    expect(heart).toEqual({ emoji: 'heart', count: 3, mine: true });
  });

  it('an optimistic "off" override subtracts 1 and never goes below zero', () => {
    const server: ReactionCount[] = [
      { emoji: 'heart', count: 1, viewer_reacted: true },
    ];
    const views = mergeReactions(server, (e) =>
      e === 'heart' ? false : undefined,
    );
    const heart = views.find((v) => v.emoji === 'heart')!;
    expect(heart).toEqual({ emoji: 'heart', count: 0, mine: false });
  });

  it('an override that already matches the server changes nothing', () => {
    const server: ReactionCount[] = [
      { emoji: 'rocket', count: 1, viewer_reacted: true },
    ];
    const views = mergeReactions(server, (e) =>
      e === 'rocket' ? true : undefined,
    );
    const rocket = views.find((v) => v.emoji === 'rocket')!;
    expect(rocket).toEqual({ emoji: 'rocket', count: 1, mine: true });
  });
});
