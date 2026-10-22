import { describe, expect, it } from 'vitest';
import type { RepoRef, Space } from '../../gen/contract';
import { ALL } from '../../core/workspaces';
import {
  AUTO_ARCHIVE_KEY,
  BUILD_MODE_KEY,
  SPACE_BUDGET_KEY,
  autoArchiveDays,
  buildModeOn,
  defaultTitle,
  fmtSpend,
  spaceBudget,
  spaceStage,
  unshipped,
  diffStat,
  isSpaceReview,
  labsVisible,
  spaceChatKey,
  spaceGlyph,
  spacesIn,
  turnEnded,
} from './spaces';

const setting = (value: unknown, scope = 'user') => ({
  key: BUILD_MODE_KEY,
  scope,
  value,
});

const space = (over: Partial<Space> & { id: string }): Space => ({
  project: 'local:app',
  name: over.id,
  goal: '',
  branch: `theo/${over.id}`,
  base: 'main',
  base_sha: 'b',
  head_sha: 'h',
  worktree: `/tmp/${over.id}`,
  status: 'idle',
  agent: 'claude',
  model: null,
  mode: 'edit',
  review_pr: null,
  pr: null,
  usage: { input_tokens: 0, output_tokens: 0, usd: 0 },
  turns: 0,
  run: null,
  error: null,
  created_at: 0,
  updated_at: 0,
  ...over,
});

describe('build mode', () => {
  it('is off by default and with the flag off', () => {
    expect(buildModeOn(false, [])).toBe(false);
    expect(buildModeOn(false, [setting(false)])).toBe(false);
  });

  it('turns on with the flag or the user setting, not a repo-scoped one', () => {
    expect(buildModeOn(true, [])).toBe(true);
    expect(buildModeOn(false, [setting(true)])).toBe(true);
    expect(buildModeOn(false, [setting(true, 'repo:acme/web')])).toBe(false);
  });

  it('lists Labs only once the setting exists, on or off', () => {
    expect(labsVisible(false, [])).toBe(false);
    expect(labsVisible(false, [setting(false)])).toBe(true);
    expect(labsVisible(true, [])).toBe(true);
  });
});

describe('spaces', () => {
  it('keys a transcript by the space id', () => {
    expect(spaceChatKey('abc')).toBe('space:abc');
  });

  it("tells a space's review from a plain branch review", () => {
    const repo: RepoRef = { host: 'local', owner: 'local', name: 'app' };
    expect(
      isSpaceReview({
        pr: { repo, number: 1, host_id: 'refs/theodore/spaces/abc' },
      }),
    ).toBe(true);
    expect(isSpaceReview({ pr: { repo, number: 1, host_id: 'feature' } })).toBe(
      false,
    );
    expect(isSpaceReview({ pr: { repo, number: 1, host_id: null } })).toBe(
      false,
    );
  });

  it("lists a project's live spaces, newest activity first; All lists every project's", () => {
    const all = [
      space({ id: 'old', updated_at: 1 }),
      space({ id: 'new', updated_at: 5 }),
      space({ id: 'gone', status: 'archived', updated_at: 9 }),
      space({ id: 'other', project: 'github:acme/web', updated_at: 3 }),
    ];
    expect(spacesIn('local:app', all).map((s) => s.id)).toEqual(['new', 'old']);
    expect(spacesIn(ALL, all).map((s) => s.id)).toEqual([
      'new',
      'other',
      'old',
    ]);
  });

  it('shows a finished turn you have not seen as waiting', () => {
    const s = space({ id: 's', turns: 1, updated_at: 10 });
    expect(spaceGlyph(s, undefined)).toBe('unseen');
    expect(spaceGlyph(s, 9)).toBe('unseen');
    expect(spaceGlyph(s, 10)).toBe('idle');
    expect(spaceGlyph({ ...s, turns: 0 }, undefined)).toBe('idle');
    expect(spaceGlyph({ ...s, status: 'running' }, 99)).toBe('running');
    expect(spaceGlyph({ ...s, status: 'failed' }, 99)).toBe('failed');
  });

  it('notices only a turn that just ended', () => {
    const next = { status: 'idle' as const, name: 'fix', error: null };
    expect(turnEnded({ status: 'running' }, next)).toEqual({
      level: 'info',
      text: 'fix: turn done',
    });
    expect(
      turnEnded(
        { status: 'running' },
        { ...next, status: 'failed', error: 'boom' },
      ),
    ).toEqual({ level: 'error', text: 'fix: turn failed — boom' });
    expect(turnEnded({ status: 'idle' }, next)).toBeNull();
    expect(turnEnded(undefined, next)).toBeNull();
    expect(
      turnEnded({ status: 'running' }, { ...next, status: 'running' }),
    ).toBeNull();
  });

  it('sums a diff stat', () => {
    expect(diffStat([])).toBe('0 files  +0 −0');
    expect(
      diffStat([
        { additions: 30, deletions: 5 },
        { additions: 12, deletions: 2 },
      ]),
    ).toBe('2 files  +42 −7');
    expect(diffStat([{ additions: 1, deletions: 0 }])).toBe('1 file  +1 −0');
  });
});

describe('shipping', () => {
  const shipped = (how: 'pr' | 'merged_locally' | 'branch', head = 'h') => ({
    how,
    branch: 'me/x',
    sha: 's1',
    head,
    pushes: 1,
    at: 1,
  });

  it('moves through its stages', () => {
    expect(spaceStage(space({ id: 'a' }))).toBe('drafting');
    expect(spaceStage(space({ id: 'a', shipped: shipped('pr') }))).toBe(
      'opening',
    );
    const pr = 'github:o/r#1';
    expect(
      spaceStage(space({ id: 'a', shipped: shipped('pr'), pr }), 'open'),
    ).toBe('in_review');
    expect(
      spaceStage(space({ id: 'a', shipped: shipped('pr'), pr }), 'merged'),
    ).toBe('done');
    expect(
      spaceStage(space({ id: 'a', shipped: shipped('merged_locally') })),
    ).toBe('merged_locally');
    expect(spaceStage(space({ id: 'a', shipped: shipped('branch') }))).toBe(
      'branch',
    );
  });

  it('knows when there are turns to push', () => {
    expect(unshipped(space({ id: 'a' }))).toBe(false);
    expect(unshipped(space({ id: 'a', shipped: shipped('pr', 'h') }))).toBe(
      false,
    );
    expect(unshipped(space({ id: 'a', shipped: shipped('pr', 'old') }))).toBe(
      true,
    );
  });

  it('proposes the goal as the title', () => {
    expect(defaultTitle({ goal: '\n  Retry on 429s \nmore', name: 'n' })).toBe(
      'Retry on 429s',
    );
    expect(defaultTitle({ goal: '', name: 'tidy' })).toBe('tidy');
  });
});

describe('space budget and archive settings', () => {
  const row = (key: string, value: unknown, scope = 'user') => ({
    key,
    scope,
    value,
  });

  it('reads the space budget, the repo row first', () => {
    expect(spaceBudget([], 'o/r')).toBe(null);
    expect(spaceBudget([row('budget.per_pr_usd', 5)], 'o/r')).toBe(null);
    expect(spaceBudget([row(SPACE_BUDGET_KEY, 5)], 'o/r')).toBe(5);
    expect(
      spaceBudget(
        [row(SPACE_BUDGET_KEY, 5), row(SPACE_BUDGET_KEY, 2, 'repo:o/r')],
        'o/r',
      ),
    ).toBe(2);
    expect(spaceBudget([row(SPACE_BUDGET_KEY, 0)], 'o/r')).toBe(null);
  });

  it('formats spend against the budget', () => {
    expect(fmtSpend(0.4217, 5)).toBe('$0.42 / $5.00');
    expect(fmtSpend(0.4, null)).toBe('$0.40');
  });

  it('defaults auto-archive to 7 days, 0 meaning never', () => {
    expect(autoArchiveDays([])).toBe(7);
    expect(autoArchiveDays([row(AUTO_ARCHIVE_KEY, 0)])).toBe(0);
    expect(autoArchiveDays([row(AUTO_ARCHIVE_KEY, 3)])).toBe(3);
    expect(autoArchiveDays([row(AUTO_ARCHIVE_KEY, -1)])).toBe(7);
    expect(autoArchiveDays([row(AUTO_ARCHIVE_KEY, 'x')])).toBe(7);
  });
});
