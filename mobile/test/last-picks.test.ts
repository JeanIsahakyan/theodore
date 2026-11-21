import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockDevices, mockMirrors, resetFleetState } from '../src/dev/mock';
import { memoryStorage } from '../src/keys/storage-types';
import {
  applyDevice,
  applyEffort,
  applyModel,
  applyWhere,
  noteStarted,
  persistPicks,
  pickerContext,
  requestNewSpace,
  resetCompose,
  resetPick,
  restorePicks,
  setHomeMode,
  useCompose,
} from '../src/state/compose';
import { useFleetState } from '../src/state/fleet';
import {
  NO_LAST_PICKS,
  lastPicksKey,
  lastPicksStore,
  parseLastPicks,
  serializeLastPicks,
} from '../src/state/lastPicks';
import { NO_PICK } from '../src/ui/agents';
import { NO_DRAFT, resolveHome } from '../src/ui/homeDraft';
import { startableDevices } from '../src/ui/logic';

const SCOPE = 'user_1.org_1';

const remembered = {
  draft: {
    deviceId: 'dev-mac',
    projectId: 'p-tama',
    mode: 'plan' as const,
    pick: { agent: 'claude', model: 'claude-sonnet-4-5', effort: 'max' },
  },
  recent: [{ deviceId: 'dev-box', projectId: 'p-api' }],
};

describe('stored form', () => {
  it('round-trips', () => {
    expect(parseLastPicks(serializeLastPicks(remembered))).toEqual(remembered);
    expect(parseLastPicks(serializeLastPicks(NO_LAST_PICKS))).toEqual(
      NO_LAST_PICKS,
    );
  });

  it('drops what is off, never trusts it', () => {
    expect(parseLastPicks(null)).toBeNull();
    expect(parseLastPicks('{not json')).toBeNull();
    expect(parseLastPicks('[]')).toBeNull();
    expect(parseLastPicks('{"v":2}')).toBeNull();
    const odd = parseLastPicks(
      JSON.stringify({
        v: 1,
        deviceId: 42,
        projectId: 'p-x',
        mode: 'yolo',
        agent: 'claude',
        recent: [{ deviceId: 'd' }, 'x', { deviceId: 'd', projectId: 'p' }],
      }),
    )!;
    // No device: no project and no pick (they belong to one).
    expect(odd.draft).toEqual(NO_DRAFT);
    expect(odd.recent).toEqual([{ deviceId: 'd', projectId: 'p' }]);
    const long = parseLastPicks(
      JSON.stringify({ v: 1, deviceId: 'x'.repeat(201), mode: 'ask' }),
    )!;
    expect(long.draft.deviceId).toBeNull();
    expect(long.draft.mode).toBe('ask');
  });
});

describe('kept per account and organization', () => {
  let data = memoryStorage();
  let store = lastPicksStore(data);
  let stop = () => {};

  beforeEach(() => {
    vi.useFakeTimers();
    data = memoryStorage();
    store = lastPicksStore(data);
    resetCompose();
    resetFleetState();
    useFleetState.setState({ devices: mockDevices });
    stop = persistPicks(store, 300);
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it('restores the last picks, still valid against the devices listed', async () => {
    await store.save(SCOPE, remembered);
    await restorePicks(store, SCOPE);
    const c = useCompose.getState();
    expect(c.restored).toBe(true);
    expect(c.home).toEqual(remembered.draft);
    expect(c.recent).toEqual(remembered.recent);
    const r = resolveHome(startableDevices(mockDevices), c.home);
    expect(r.project?.name).toBe('tamagochi');
    expect(r.pick).toEqual(remembered.draft.pick);
  });

  it('invalid once the device lists other things: shown without them', async () => {
    await store.save(SCOPE, remembered);
    await restorePicks(store, SCOPE);
    // The Mac now offers only Codex and lost tamagochi.
    useFleetState.setState({
      devices: mockDevices.map((d) =>
        d.deviceId === 'dev-mac'
          ? {
              ...d,
              projects: d.projects.filter((p) => p.id !== 'p-tama'),
              agents: d.agents.filter((a) => a.id === 'codex'),
            }
          : d,
      ),
    });
    const ctx = pickerContext(
      useFleetState.getState(),
      useCompose.getState(),
      null,
    );
    expect(ctx.pick).toEqual(NO_PICK);
    const r = resolveHome(
      startableDevices(useFleetState.getState().devices),
      useCompose.getState().home,
    );
    expect(r.project?.id).toBe('p-theodore');
  });

  it('writes a change 300 ms later, the recent projects too', async () => {
    await restorePicks(store, SCOPE);
    applyWhere('dev-box', 'p-api');
    setHomeMode('run');
    noteStarted('dev-box', 'p-api');
    expect(await data.get(lastPicksKey(SCOPE))).toBeNull();
    await vi.advanceTimersByTimeAsync(300);
    expect(await store.load(SCOPE)).toEqual({
      draft: {
        deviceId: 'dev-box',
        projectId: 'p-api',
        mode: 'run',
        pick: NO_PICK,
      },
      recent: [{ deviceId: 'dev-box', projectId: 'p-api' }],
    });
  });

  it('another org: its own picks; none written across', async () => {
    await store.save(SCOPE, remembered);
    await restorePicks(store, SCOPE);
    setHomeMode('ask');
    await restorePicks(store, 'user_1.org_2');
    await vi.advanceTimersByTimeAsync(300);
    expect(useCompose.getState().home).toEqual(NO_DRAFT);
    expect((await store.load(SCOPE))?.draft.mode).toBe('plan');
    expect(await store.load('user_1.org_2')).toBeNull();
    await restorePicks(store, null);
    expect(useCompose.getState().scope).toBeNull();
  });

  it('a pick made while reading wins over what was stored', async () => {
    await store.save(SCOPE, remembered);
    const reading = restorePicks(store, SCOPE);
    setHomeMode('ask');
    await reading;
    expect(useCompose.getState().home.mode).toBe('ask');
    expect(useCompose.getState().home.deviceId).toBeNull();
  });

  it("Home's model pick is pinned to the device shown; Reset clears it", async () => {
    await restorePicks(store, SCOPE);
    const closes = applyModel(null, 'claude', 'claude-sonnet-4-5');
    expect(closes).toBe(false);
    applyEffort(null, 'low');
    const home = useCompose.getState().home;
    expect(home.deviceId).toBe('dev-mac');
    expect(home.pick).toEqual({
      agent: null,
      model: 'claude-sonnet-4-5',
      effort: 'low',
    });
    expect(applyModel(null, 'claude', 'claude-haiku-4-5')).toBe(true);
    resetPick(null);
    expect(useCompose.getState().home.pick).toEqual(NO_PICK);
  });

  it("a space's pick stays its own, against its host and its own row", async () => {
    useFleetState.setState({
      spaces: [
        {
          space: 'sp-idle',
          hostDevice: 'dev-mac',
          hostName: 'MacBook Pro',
          originDevice: 'dev-me',
          projectName: 'theodore',
          name: 'x',
          branch: 'b',
          status: 'idle',
          mode: 'edit',
          lastReply: null,
          question: null,
          startedHere: true,
          error: null,
        },
      ],
      mirrors: { 'sp-idle': mockMirrors['sp-idle']! },
    });
    applyModel('sp-idle', 'codex', 'gpt-5-codex');
    const c = useCompose.getState();
    expect(c.spacePicks['sp-idle']).toEqual({
      agent: 'codex',
      model: 'gpt-5-codex',
      effort: null,
    });
    expect(c.home).toEqual(NO_DRAFT);
    const ctx = pickerContext(useFleetState.getState(), c, 'sp-idle');
    expect(ctx.current.agent).toBe('claude');
    expect(ctx.agents.map((a) => a.id)).toEqual(['claude', 'codex']);
  });

  it('another computer: its last project, else its first; the same keeps the shown one', () => {
    const mac = mockDevices.find((d) => d.deviceId === 'dev-mac')!;
    const box = mockDevices.find((d) => d.deviceId === 'dev-box')!;
    applyWhere('dev-mac', 'p-tama');
    applyDevice('dev-mac');
    expect(useCompose.getState().home.projectId).toBe('p-tama');
    applyDevice('dev-box');
    expect(useCompose.getState().home).toMatchObject({
      deviceId: 'dev-box',
      projectId: box.projects[0]!.id,
    });
    noteStarted('dev-mac', mac.projects.at(-1)!.id);
    applyDevice('dev-mac');
    expect(useCompose.getState().home).toMatchObject({
      deviceId: 'dev-mac',
      projectId: mac.projects.at(-1)!.id,
    });
  });

  it('"new space" bumps the request Home answers', () => {
    const before = useCompose.getState().fresh;
    requestNewSpace();
    expect(useCompose.getState().fresh).toBe(before + 1);
  });
});
