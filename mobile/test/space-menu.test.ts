import { describe, expect, it, vi } from 'vitest';
import type { FleetDeviceView, SpaceView } from '../src/fleet/types';
import {
  archiveSpaceFlow,
  type ArchiveDeps,
  type ArchiveTelemetry,
} from '../src/ui/archiveFlow';
import { runSpaceMenuItem, spaceMenuItems } from '../src/ui/spaceMenu';

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

describe('spaceMenuItems', () => {
  it('offers Archive, destructive, for a space this phone may archive', () => {
    expect(spaceMenuItems(space(), [host()])).toEqual([
      { id: 'archive', label: 'Archive', icon: 'archive', destructive: true },
    ]);
  });

  it('is empty (no menu) when the device cannot archive it', () => {
    expect(spaceMenuItems(space(), [host({ trusted: false })])).toEqual([]);
    expect(spaceMenuItems(space(), [])).toEqual([]);
    expect(spaceMenuItems(space({ status: 'starting' }), [host()])).toEqual([]);
    expect(
      spaceMenuItems(space({ startedHere: false }), [
        host({ acceptsRemote: false }),
      ]),
    ).toEqual([]);
  });
});

describe('runSpaceMenuItem', () => {
  it('Archive runs the archive flow on that space', async () => {
    const archive = vi.fn(async () => true);
    const s = space();
    await expect(runSpaceMenuItem('archive', s, { archive })).resolves.toBe(
      true,
    );
    expect(archive).toHaveBeenCalledWith(s);
  });
});

/** The flow's dependencies, every call recorded. */
function deps(
  over: {
    confirm?: boolean;
    row?: ReturnType<ArchiveDeps['row']>;
    archiveError?: Error;
  } = {},
) {
  const events: ArchiveTelemetry[] = [];
  const toasts: Parameters<ArchiveDeps['showToast']>[0][] = [];
  const confirms: Parameters<ArchiveDeps['confirm']>[0][] = [];
  const stopSpace = vi.fn(async () => {});
  const archiveSpace = vi.fn(async () => {
    if (over.archiveError) throw over.archiveError;
  });
  const unarchiveSpace = vi.fn(async () => {});
  const d: ArchiveDeps = {
    fleet: { stopSpace, archiveSpace, unarchiveSpace },
    row: () => over.row ?? null,
    confirm: async (o) => {
      confirms.push(o);
      return over.confirm ?? true;
    },
    showToast: (t) => toasts.push(t),
    track: (_e, p) => events.push(p),
  };
  return {
    d,
    events,
    toasts,
    confirms,
    stopSpace,
    archiveSpace,
    unarchiveSpace,
  };
}

describe('archiveSpaceFlow from the row menu', () => {
  it('confirms, archives, toasts Undo and tracks the surface', async () => {
    const t = deps();
    await expect(archiveSpaceFlow(t.d, 'row_menu', space())).resolves.toBe(
      true,
    );
    expect(t.confirms).toEqual([
      {
        title: 'Archive “Fix the login bug”?',
        message: 'Its worktree is removed; the branch and PR stay.',
        confirmLabel: 'Archive',
        destructive: true,
      },
    ]);
    expect(t.stopSpace).not.toHaveBeenCalled();
    expect(t.archiveSpace).toHaveBeenCalledWith('rs_1');
    expect(t.events).toEqual([
      {
        action: 'archive',
        surface: 'row_menu',
        stopped_first: false,
        outcome: 'ok',
        code: null,
      },
    ]);
    expect(t.toasts[0]?.text).toBe('Archived');
    expect(t.toasts[0]?.action?.label).toBe('Undo');
  });

  it('Undo unarchives and tracks it', async () => {
    const t = deps();
    await archiveSpaceFlow(t.d, 'row_menu', space());
    t.toasts[0]!.action!.onPress();
    await vi.waitFor(() => expect(t.events).toHaveLength(2));
    expect(t.unarchiveSpace).toHaveBeenCalledWith('rs_1');
    expect(t.events[1]).toEqual({
      action: 'unarchive',
      surface: 'row_menu',
      stopped_first: false,
      outcome: 'ok',
      code: null,
    });
  });

  it('a running space: "Stop and archive", stopped first', async () => {
    const t = deps();
    await archiveSpaceFlow(t.d, 'row_menu', space({ status: 'running' }));
    expect(t.confirms[0]?.confirmLabel).toBe('Stop and archive');
    expect(t.stopSpace).toHaveBeenCalledWith('rs_1');
    expect(t.archiveSpace).toHaveBeenCalledWith('rs_1');
    expect(t.events[0]?.stopped_first).toBe(true);
  });

  it('warns about unshipped changes from the mirrored row', async () => {
    const t = deps({
      row: { pr: null, shipped: null, base_sha: 'aaa', head_sha: 'bbb' },
    });
    await archiveSpaceFlow(t.d, 'row_menu', space());
    expect(t.confirms[0]?.message).toMatch(/not pushed or merged/);
  });

  it('Cancel: nothing sent, nothing tracked', async () => {
    const t = deps({ confirm: false });
    await expect(archiveSpaceFlow(t.d, 'row_menu', space())).resolves.toBe(
      false,
    );
    expect(t.archiveSpace).not.toHaveBeenCalled();
    expect(t.events).toEqual([]);
    expect(t.toasts).toEqual([]);
  });

  it('a refusal: the hint as a toast, the code tracked', async () => {
    const t = deps({
      archiveError: new Error('refused by the cloud: fleet.upgrade_required'),
    });
    await expect(archiveSpaceFlow(t.d, 'row_menu', space())).resolves.toBe(
      false,
    );
    expect(t.toasts).toEqual([
      { text: 'Update Theodore on mac-A to archive from here' },
    ]);
    expect(t.events[0]).toMatchObject({
      outcome: 'failed',
      code: 'fleet.upgrade_required',
      surface: 'row_menu',
    });
  });
});
