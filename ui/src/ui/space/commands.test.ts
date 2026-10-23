import { describe, expect, it } from 'vitest';
import type {
  ConfigEntry,
  SpaceCheck,
  SpaceConfigView,
  SpaceLogLine,
  SpaceTurn,
} from '../../gen/contract';
import {
  appendLogs,
  checkChip,
  checksByReply,
  fileStatus,
  filterLogs,
  groupEntries,
  logCounts,
  runControl,
  seedLogs,
  setupView,
  trustState,
} from './commands';

const line = (
  at: number,
  text: string,
  kind: SpaceLogLine['kind'] = 'setup',
  stderr = false,
): SpaceLogLine => ({ kind, line: text, stderr, at });

const config = (over: Partial<SpaceConfigView> = {}): SpaceConfigView => ({
  commands: [],
  ports: [],
  repo_commands: null,
  denied: false,
  ...over,
});

describe('log buffer', () => {
  it('keeps the newest lines up to the limit', () => {
    const buf = [line(1, 'a'), line(2, 'b')];
    expect(appendLogs(buf, [line(3, 'c')], 2).map((l) => l.line)).toEqual([
      'b',
      'c',
    ]);
    expect(appendLogs([], [line(1, 'a')])).toHaveLength(1);
  });

  it('seeds from the tail and keeps live lines it lacks', () => {
    const seed = [line(1, 'a'), line(2, 'b')];
    const live = [line(2, 'b'), line(2, 'b2'), line(3, 'c'), line(1, 'old')];
    expect(seedLogs(seed, live).map((l) => l.line)).toEqual([
      'a',
      'b',
      'b2',
      'c',
    ]);
    expect(seedLogs([], [line(5, 'x')]).map((l) => l.line)).toEqual(['x']);
  });

  it('filters and counts by kind', () => {
    const lines = [line(1, 'a'), line(2, 'b', 'run'), line(3, 'c', 'run')];
    expect(filterLogs(lines, 'all')).toBe(lines);
    expect(filterLogs(lines, 'run').map((l) => l.line)).toEqual(['b', 'c']);
    expect(logCounts(lines)).toEqual({
      all: 3,
      setup: 1,
      run: 2,
      check: 0,
      archive: 0,
    });
  });
});

describe('trust prompt', () => {
  const repo = { hash: 'h', trusted: false, items: [] };
  it('asks while the repo commands are neither allowed nor denied', () => {
    expect(trustState(null)).toBeNull();
    expect(trustState(config())).toBeNull();
    expect(trustState(config({ repo_commands: repo }))).toBe('ask');
    expect(trustState(config({ repo_commands: repo, denied: true }))).toBe(
      'denied',
    );
    expect(
      trustState(config({ repo_commands: { ...repo, trusted: true } })),
    ).toBeNull();
  });
});

describe('setup stage', () => {
  type Status = 'waiting' | 'running' | 'done' | 'failed' | 'skipped';
  const setup = (status: Status, notes: string[] = []) => ({
    setup: {
      status,
      goal_pending: true,
      error: null,
      notes,
      finished_at: null,
    },
  });
  it('shows the stage until setup ends, then only notes', () => {
    expect(setupView({ setup: null })).toBeNull();
    expect(setupView(setup('waiting'))).toBe('stage');
    expect(setupView(setup('running'))).toBe('stage');
    expect(setupView(setup('failed'))).toBe('stage');
    expect(setupView(setup('done'))).toBeNull();
    expect(setupView(setup('skipped', ['.env not copied']))).toBe('note');
  });
});

describe('run control', () => {
  const run = (allowed: boolean) =>
    config({
      commands: [{ kind: 'run', script: 'pnpm dev', layer: 'repo', allowed }],
    });
  const idle = { status: 'idle' as const, process: null };

  it('shows only for an allowed run command on a live space', () => {
    expect(runControl(null, idle)).toBeNull();
    expect(runControl(run(false), idle)).toBeNull();
    expect(
      runControl(run(true), { status: 'archived', process: null }),
    ).toBeNull();
    expect(runControl(run(true), idle)).toEqual({
      running: false,
      script: 'pnpm dev',
      last: null,
    });
  });

  it('reads running and how the last run ended from the process', () => {
    type P = 'running' | 'exited' | 'stopped' | 'failed';
    const p = (status: P, extra = {}) => ({
      status: 'idle' as const,
      process: { status, started_at: 1, ...extra },
    });
    expect(runControl(run(true), p('running'))?.running).toBe(true);
    expect(runControl(run(true), p('exited', { exit_code: 1 }))?.last).toBe(
      'exited 1',
    );
    expect(runControl(run(true), p('stopped'))?.last).toBe('stopped');
    expect(
      runControl(run(true), p('failed', { error: 'no such file' }))?.last,
    ).toBe('could not start: no such file');
  });
});

describe('check chip', () => {
  const check = (over: Partial<SpaceCheck>): SpaceCheck => ({
    status: 'failed',
    started_at: 0,
    ...over,
  });

  it('labels each outcome; a timeout is a fail', () => {
    expect(checkChip(check({ status: 'running' }))).toEqual({
      tone: 'running',
      label: 'Checking…',
    });
    expect(checkChip(check({ status: 'passed' })).tone).toBe('passed');
    expect(checkChip(check({ exit_code: 2 })).label).toBe(
      'Check failed (exit 2)',
    );
    expect(checkChip(check({ timed_out: true, exit_code: null }))).toEqual({
      tone: 'failed',
      label: 'Check timed out',
    });
  });

  it('maps checks to the reply that ended the turn', () => {
    const t = (reply: string, c: SpaceCheck | null): SpaceTurn => ({
      message: `m-${reply}`,
      reply,
      before: 'a',
      after: 'b',
      check: c,
    });
    const m = checksByReply([t('r1', null), t('r2', check({}))]);
    expect([...m.keys()]).toEqual(['r2']);
    expect(checksByReply(undefined).size).toBe(0);
  });
});

describe('project config', () => {
  const f = { layer: 'repo' as const, path: '/r/.review/config.yaml' };

  it('describes each file', () => {
    expect(
      fileStatus({ ...f, exists: true, legacy: false, error: null }),
    ).toBeNull();
    expect(
      fileStatus({ ...f, exists: false, legacy: false, error: null }),
    ).toBe('not present');
    expect(fileStatus({ ...f, exists: true, legacy: true, error: null })).toBe(
      'deprecated .review/config.yaml',
    );
    expect(
      fileStatus({ ...f, exists: true, legacy: false, error: 'bad yaml' }),
    ).toBe('ignored: bad yaml');
  });

  it('groups entries by their first key segment', () => {
    const e = (key: string): ConfigEntry => ({
      key,
      value: 'v',
      layer: 'global',
    });
    const g = groupEntries([e('spaces.run'), e('review.x'), e('spaces.check')]);
    expect(g.map((x) => x.section)).toEqual(['spaces', 'review']);
    expect(g[0]!.entries.map((x) => x.key)).toEqual([
      'spaces.check',
      'spaces.run',
    ]);
  });
});
