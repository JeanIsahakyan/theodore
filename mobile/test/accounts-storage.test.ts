import { describe, expect, it } from 'vitest';
import { savedScope, savedSpaces, type SavedSpace } from '../src/fleet/saved';
import { memoryStorage } from '../src/keys/storage-types';
import { lastPicksStore } from '../src/state/lastPicks';
import { NO_DRAFT } from '../src/ui/homeDraft';

const DEVICE = 'dev_00000000-0000-4000-8000-0000000000a1';

const saved = (space: string): SavedSpace => ({
  view: {
    space,
    hostDevice: 'dev_00000000-0000-4000-8000-0000000000b2',
    hostName: 'mac-A',
    originDevice: DEVICE,
    projectName: 'theodore',
    name: space,
    branch: '',
    status: 'idle',
    mode: 'edit',
    lastReply: null,
    question: null,
    startedHere: true,
    error: null,
  },
  lastSeq: 1,
  startedName: space,
  seenAt: 1,
  lines: [],
  mirror: { space: null, messages: [], subSpaces: [] },
});

// What is kept across restarts is partitioned per <user>.<org>: two
// accounts (or two orgs of one) never see each other's spaces or picks,
// and one leaving takes only its own.
describe('per-account storage', () => {
  it('scopes differ per user and per org', () => {
    expect(savedScope('u_a', 'org_1')).toBe('u_a.org_1');
    expect(savedScope('u_a', 'org_1')).not.toBe(savedScope('u_b', 'org_1'));
    expect(savedScope('u_a', 'org_1')).not.toBe(savedScope('u_a', 'org_2'));
  });

  it('keeps saved spaces apart and removes one scope only', async () => {
    const storage = memoryStorage();
    const store = savedSpaces(storage);
    const a = savedScope('u_a', 'org_1');
    const b = savedScope('u_b', 'org_1');
    await store.write(a, DEVICE, [saved('rs_a1'), saved('rs_a2')], new Set());
    await store.write(b, DEVICE, [saved('rs_b1')], new Set());
    expect((await store.load(a, DEVICE)).map((s) => s.view.space)).toEqual([
      'rs_a1',
      'rs_a2',
    ]);
    expect((await store.load(b, DEVICE)).map((s) => s.view.space)).toEqual([
      'rs_b1',
    ]);
    expect(await store.spacesOf(a)).toEqual(['rs_a1', 'rs_a2']);
    expect(await store.spacesOf(savedScope('u_c', 'org_1'))).toEqual([]);
    await store.clear(a);
    expect(await store.load(a, DEVICE)).toEqual([]);
    expect(await store.spacesOf(a)).toEqual([]);
    expect((await store.load(b, DEVICE)).map((s) => s.view.space)).toEqual([
      'rs_b1',
    ]);
  });

  it('keeps last picks apart per scope', async () => {
    const picks = lastPicksStore(memoryStorage());
    const a = savedScope('u_a', 'org_1');
    const b = savedScope('u_a', 'org_2');
    await picks.save(a, {
      draft: { ...NO_DRAFT, deviceId: 'd1', projectId: 'p1' },
      recent: [{ deviceId: 'd1', projectId: 'p1' }],
    });
    expect((await picks.load(a))?.draft.deviceId).toBe('d1');
    expect(await picks.load(b)).toBeNull();
    await picks.clear(a);
    expect(await picks.load(a)).toBeNull();
  });
});
