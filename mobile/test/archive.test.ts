import { describe, expect, it } from 'vitest';
import type { Space } from '../src/fleet/contract';
import type { FleetDeviceView, SpaceView } from '../src/fleet/types';
import {
  archiveConfirm,
  archiveErrorText,
  canArchive,
  hasUnshippedChanges,
} from '../src/ui/archive';

const host = (over: Partial<FleetDeviceView> = {}): FleetDeviceView => ({
  deviceId: 'dev-mac',
  name: 'mac-A',
  kind: 'desktop',
  os: 'macos',
  online: true,
  acceptsRemote: true,
  maxMode: 'edit',
  projects: [],
  agents: [],
  publicKey: 'pk',
  fingerprint: '',
  trusted: true,
  thisDevice: false,
  mcpAuto: [],
  ...over,
});

const space = (over: Partial<SpaceView> = {}): SpaceView => ({
  space: 'rs_1',
  hostDevice: 'dev-mac',
  hostName: 'mac-A',
  originDevice: '',
  projectName: 'theodore',
  name: 'Fix the login bug',
  branch: 'th/login',
  status: 'idle',
  mode: 'edit',
  lastReply: null,
  question: null,
  startedHere: true,
  error: null,
  ...over,
});

const row = (
  over: Partial<Pick<Space, 'pr' | 'shipped' | 'head_sha' | 'base_sha'>> = {},
) => ({
  pr: null,
  shipped: null,
  base_sha: 'aaa',
  head_sha: 'bbb',
  ...over,
});

describe('canArchive', () => {
  it('a space started here on a trusted host', () => {
    expect(canArchive(space(), [host()])).toBe(true);
  });

  it('never without the host pinned here', () => {
    expect(canArchive(space(), [host({ trusted: false })])).toBe(false);
    expect(canArchive(space(), [])).toBe(false);
    expect(canArchive(space({ hostDevice: '' }), [host()])).toBe(false);
  });

  it('a followed space only when the host takes remote requests', () => {
    const followed = space({ startedHere: false });
    expect(canArchive(followed, [host({ acceptsRemote: true })])).toBe(true);
    expect(canArchive(followed, [host({ acceptsRemote: false })])).toBe(false);
  });

  it('nothing to archive while it starts', () => {
    expect(canArchive(space({ status: 'starting' }), [host()])).toBe(false);
  });
});

describe('archiveConfirm', () => {
  it('idle: the title in quotes, what stays', () => {
    expect(archiveConfirm(space(), { unshipped: false })).toEqual({
      title: 'Archive “Fix the login bug”?',
      message: 'Its worktree is removed; the branch and PR stay.',
      confirmLabel: 'Archive',
      stopFirst: false,
    });
  });

  it('running: stopped first', () => {
    expect(
      archiveConfirm(space({ status: 'running' }), { unshipped: false }),
    ).toEqual({
      title: 'Archive “Fix the login bug”?',
      message:
        'The agent is still working: it is stopped first. Its worktree is removed; the branch and PR stay.',
      confirmLabel: 'Stop and archive',
      stopFirst: true,
    });
  });

  it('unshipped work: a warning after', () => {
    expect(archiveConfirm(space(), { unshipped: true }).message).toBe(
      'Its worktree is removed; the branch and PR stay. It has changes that were not pushed or merged.',
    );
  });

  it('names a space by its branch, else "Untitled space"', () => {
    expect(
      archiveConfirm(space({ name: '' }), { unshipped: false }).title,
    ).toBe('Archive “th/login”?');
    expect(
      archiveConfirm(space({ name: '', branch: '' }), { unshipped: false })
        .title,
    ).toBe('Archive “Untitled space”?');
  });
});

describe('hasUnshippedChanges', () => {
  it('a checkpoint past the fork, nothing shipped', () => {
    expect(hasUnshippedChanges(row())).toBe(true);
  });

  it('shipped by a PR, a push or a local merge', () => {
    expect(hasUnshippedChanges(row({ pr: 'pr_1' }))).toBe(false);
    expect(
      hasUnshippedChanges(
        row({ shipped: { how: 'merged_locally', branch: 'main', sha: 'c' } }),
      ),
    ).toBe(false);
  });

  it('nothing done, or no row', () => {
    expect(hasUnshippedChanges(row({ head_sha: 'aaa' }))).toBe(false);
    expect(hasUnshippedChanges(row({ head_sha: '', base_sha: '' }))).toBe(
      false,
    );
    expect(hasUnshippedChanges(null)).toBe(false);
  });
});

describe('archiveErrorText', () => {
  it('an older host, a running turn, anything else', () => {
    expect(
      archiveErrorText(
        new Error('refused by the cloud: fleet.upgrade_required'),
        'mac-A',
      ),
    ).toBe('Update Theodore on mac-A to archive from here');
    expect(
      archiveErrorText(
        new Error('the other device refused: fleet.busy: stop it first'),
        'mac-A',
      ),
    ).toBe('Stop the space first, then archive it.');
    expect(
      archiveErrorText(
        new Error('the other device refused: fleet.untrusted_device'),
        'mac-A',
      ),
    ).toMatch(/doesn't trust this device/);
    expect(archiveErrorText(new Error('boom'), 'mac-A')).toBe('boom');
  });
});
