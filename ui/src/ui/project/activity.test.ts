import { describe, expect, it } from 'vitest';
import type { RepoRef } from '../../gen/contract';
import type { InboxPr } from '../List';
import { projectActivity } from './activity';

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

describe('projectActivity', () => {
  it('maps each state to its event kind', () => {
    const items = [
      pr({ id: '1', state: 'open' }),
      pr({ id: '2', state: 'draft' }),
      pr({ id: '3', state: 'merged' }),
      pr({ id: '4', state: 'closed' }),
    ];
    const kinds = Object.fromEntries(
      projectActivity(items).map((e) => [e.id, e.kind]),
    );
    expect(kinds).toEqual({
      '1': 'opened',
      '2': 'opened',
      '3': 'merged',
      '4': 'closed',
    });
  });

  it('sorts newest first', () => {
    const items = [
      pr({ id: 'old', updated_at: 1 }),
      pr({ id: 'new', updated_at: 2 }),
    ];
    expect(projectActivity(items).map((e) => e.id)).toEqual(['new', 'old']);
  });

  it('caps the feed at the given limit', () => {
    const items = Array.from({ length: 5 }, (_, i) => pr({ id: String(i) }));
    expect(projectActivity(items, 3)).toHaveLength(3);
  });
});
