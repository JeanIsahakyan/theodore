import { describe, expect, it } from 'vitest';
import {
  continueNote,
  mergedChipItems,
  mergedPr,
  prWebUrl,
} from '../src/ui/merged';

describe('mergedPr', () => {
  it('a merged PR: its number and id', () => {
    expect(
      mergedPr({ pr: 'github:acme/app#12', done_at: 1_700_000_000_000 }),
    ).toEqual({ number: 12, id: 'github:acme/app#12' });
  });

  it('null without a pr (merged locally) or without done_at (still open)', () => {
    expect(mergedPr({ pr: null, done_at: 1 })).toBeNull();
    expect(
      mergedPr({
        pr: null,
        done_at: 1,
        shipped: { how: 'merged_locally', branch: 'b', sha: 's' },
      }),
    ).toBeNull();
    expect(mergedPr({ pr: 'github:acme/app#12', done_at: null })).toBeNull();
    expect(mergedPr({ pr: 'github:acme/app#12' })).toBeNull();
    expect(mergedPr(null)).toBeNull();
    expect(mergedPr(undefined)).toBeNull();
  });

  it('parses the number after the last #, rejects a bad one', () => {
    expect(mergedPr({ pr: 'gitlab:g/sub/p#x#7', done_at: 1 })?.number).toBe(7);
    expect(mergedPr({ pr: 'github:acme/app#', done_at: 1 })).toBeNull();
    expect(mergedPr({ pr: 'github:acme/app#0', done_at: 1 })).toBeNull();
    expect(mergedPr({ pr: 'github:acme/app#1.5', done_at: 1 })).toBeNull();
    expect(mergedPr({ pr: 'no-hash', done_at: 1 })).toBeNull();
  });
});

describe('prWebUrl', () => {
  it('GitHub, GitLab (nested groups), Bitbucket', () => {
    expect(prWebUrl('github:acme/my.app-2#12')).toBe(
      'https://github.com/acme/my.app-2/pull/12',
    );
    expect(prWebUrl('gitlab:group/sub/proj#3')).toBe(
      'https://gitlab.com/group/sub/proj/-/merge_requests/3',
    );
    expect(prWebUrl('bitbucket:team/repo#4')).toBe(
      'https://bitbucket.org/team/repo/pull-requests/4',
    );
  });

  it('rejects a slug that is not a slug', () => {
    expect(prWebUrl('github:acme/app/../x#1')).toBeNull();
    expect(prWebUrl('github:acme#1')).toBeNull();
    expect(prWebUrl('github:acme/app/extra#1')).toBeNull();
    expect(prWebUrl('github:ac me/app#1')).toBeNull();
    expect(prWebUrl('github:acme/app?x=1#1')).toBeNull();
    expect(prWebUrl('github:evil.com/#/x#1')).toBeNull();
    expect(prWebUrl('github:acme/app#1e3')).toBeNull();
    expect(prWebUrl('github:acme/app#')).toBeNull();
    expect(prWebUrl('github:/app#1')).toBeNull();
  });

  it('null for a host with no page here', () => {
    expect(prWebUrl('local:acme/app#1')).toBeNull();
    expect(prWebUrl('gitea:acme/app#1')).toBeNull();
    expect(prWebUrl('acme/app#1')).toBeNull();
    expect(prWebUrl(':acme/app#1')).toBeNull();
    expect(prWebUrl('')).toBeNull();
  });
});

describe('mergedChipItems', () => {
  it('Continue alone without a URL or the right to archive', () => {
    expect(mergedChipItems({ prUrl: null, canArchive: false })).toEqual([
      { id: 'continue', label: 'Continue on a new branch' },
    ]);
  });

  it('Open PR #N with a URL', () => {
    expect(
      mergedChipItems({
        prUrl: 'https://github.com/a/b/pull/12',
        canArchive: false,
        number: 12,
      }).map((i) => i.label),
    ).toEqual(['Continue on a new branch', 'Open PR #12']);
  });

  it('Archive, destructive, when canArchive', () => {
    const items = mergedChipItems({
      prUrl: 'https://github.com/a/b/pull/12',
      canArchive: true,
      number: 12,
    });
    expect(items.map((i) => i.id)).toEqual(['continue', 'pr', 'archive']);
    expect(items[2]).toEqual({
      id: 'archive',
      label: 'Archive',
      destructive: true,
    });
    expect(items[0].destructive).toBeUndefined();
    expect(items[1].destructive).toBeUndefined();
  });
});

describe('continueNote', () => {
  it('names the base, else "base"', () => {
    expect(continueNote('main')).toBe(
      'Your next message continues on a new branch from the updated main.',
    );
    expect(continueNote('')).toBe(
      'Your next message continues on a new branch from the updated base.',
    );
    expect(continueNote(undefined)).toContain('updated base.');
  });
});
