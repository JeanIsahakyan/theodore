import { describe, expect, it } from 'vitest';
import type { RepoRef } from '../../gen/contract';
import type { InboxPr } from '../List';
import { projectPrSections } from './sections';

const repo: RepoRef = { host: 'github', owner: 'acme', name: 'web' };

const pr = (over: Partial<InboxPr> & { id: string }): InboxPr => ({
  pr: { repo, number: 1, host_id: null },
  title: 'a change',
  author: { login: 'me', name: null, avatar_url: null },
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
});

describe('projectPrSections', () => {
  it("puts a PR that needs the viewer's review first, even if they authored it", () => {
    const items = [
      pr({
        id: '1',
        reasons: ['review_requested'],
        author: { login: 'me', name: null, avatar_url: null },
      }),
    ];
    const groups = projectPrSections(items, 'me');
    expect(
      groups.find((g) => g.id === 'needs_review')!.items.map((p) => p.id),
    ).toEqual(['1']);
    expect(groups.find((g) => g.id === 'yours')!.items).toEqual([]);
  });

  it('files an open PR the viewer authored under "yours", not "open"', () => {
    const items = [
      pr({ id: '1', author: { login: 'me', name: null, avatar_url: null } }),
    ];
    const groups = projectPrSections(items, 'me');
    expect(
      groups.find((g) => g.id === 'yours')!.items.map((p) => p.id),
    ).toEqual(['1']);
    expect(groups.find((g) => g.id === 'open')!.items).toEqual([]);
  });

  it('splits open, draft, merged and closed into their own sections', () => {
    const items = [
      pr({
        id: 'o',
        state: 'open',
        author: { login: 'them', name: null, avatar_url: null },
      }),
      pr({
        id: 'd',
        state: 'draft',
        author: { login: 'them', name: null, avatar_url: null },
      }),
      pr({
        id: 'm',
        state: 'merged',
        author: { login: 'them', name: null, avatar_url: null },
      }),
      pr({
        id: 'c',
        state: 'closed',
        author: { login: 'them', name: null, avatar_url: null },
      }),
    ];
    const groups = projectPrSections(items, 'me');
    expect(groups.find((g) => g.id === 'open')!.items.map((p) => p.id)).toEqual(
      ['o'],
    );
    expect(
      groups.find((g) => g.id === 'drafts')!.items.map((p) => p.id),
    ).toEqual(['d']);
    expect(
      groups.find((g) => g.id === 'merged')!.items.map((p) => p.id),
    ).toEqual(['m']);
    expect(
      groups.find((g) => g.id === 'closed')!.items.map((p) => p.id),
    ).toEqual(['c']);
  });

  it('sorts each section by activity, newest first', () => {
    const items = [
      pr({
        id: 'old',
        state: 'open',
        updated_at: 1,
        author: { login: 'them', name: null, avatar_url: null },
      }),
      pr({
        id: 'new',
        state: 'open',
        updated_at: 2,
        author: { login: 'them', name: null, avatar_url: null },
      }),
    ];
    const groups = projectPrSections(items, 'me');
    expect(groups.find((g) => g.id === 'open')!.items.map((p) => p.id)).toEqual(
      ['new', 'old'],
    );
  });

  it('collapses "Recently merged" by default only when there is open-ish work', () => {
    const withOpen = projectPrSections(
      [pr({ id: '1', state: 'open' }), pr({ id: '2', state: 'merged' })],
      null,
    );
    expect(withOpen.find((g) => g.id === 'merged')!.collapsedByDefault).toBe(
      true,
    );

    const mergedOnly = projectPrSections(
      [pr({ id: '2', state: 'merged' })],
      null,
    );
    expect(mergedOnly.find((g) => g.id === 'merged')!.collapsedByDefault).toBe(
      false,
    );
  });

  it('sorts by size (additions + deletions) when asked', () => {
    const items = [
      pr({ id: 'small', state: 'open', additions: 1, deletions: 0 }),
      pr({ id: 'big', state: 'open', additions: 10, deletions: 0 }),
    ];
    const groups = projectPrSections(items, null, 'size');
    expect(groups.find((g) => g.id === 'open')!.items.map((p) => p.id)).toEqual(
      ['big', 'small'],
    );
  });

  it('always returns every section, in a fixed order, even when empty', () => {
    const groups = projectPrSections([], null);
    expect(groups.map((g) => g.id)).toEqual([
      'needs_review',
      'yours',
      'open',
      'drafts',
      'merged',
      'closed',
    ]);
  });
});
