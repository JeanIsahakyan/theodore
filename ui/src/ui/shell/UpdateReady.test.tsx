import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, mount, type Mounted } from '../../test/dom';
import { setTransport } from '../../core/transport';
import { RootStore } from '../../stores/RootStore';
import { RootStoreProvider } from '../../stores/context';
import { FakeTransport } from '../../test/fakeTransport';
import {
  RESTART_POLL_MS,
  UpdateReady,
  pauseWarning,
  runningAgents,
  waitingText,
} from './UpdateReady';
import type { Space } from '../../gen/contract';

const space = (over: Partial<Space>): Space => ({
  id: 's1',
  project: 'local:app',
  name: 's1',
  goal: '',
  branch: 'theo/s1',
  base: 'main',
  base_sha: 'b',
  head_sha: 'h',
  worktree: '/tmp/s1',
  status: 'running',
  agent: 'claude',
  model: null,
  mode: 'edit',
  review_pr: null,
  pr: null,
  turns: 1,
  run: 'space:s1:m1',
  error: null,
  created_at: 0,
  updated_at: 0,
  ...over,
});

let m: Mounted | null = null;
let transport: FakeTransport;
let store: RootStore;

beforeEach(() => {
  transport = new FakeTransport();
  setTransport(transport);
  // Busy: `install_update` answers without restarting.
  transport.onCall('install_update', () => null);
  store = new RootStore();
  store.ephemeral.setAppInfo({
    version: '0.1.6',
    commit: 'abc',
    build_env: 'production',
    built_at: 0,
    channel: 'stable',
    update: { version: '0.1.7', notes: '', downloaded: true },
  });
});

afterEach(() => {
  m?.unmount();
  m = null;
  vi.useRealTimers();
});

const button = (label: RegExp) =>
  [...m!.host.querySelectorAll('button')].find((b) =>
    label.test(b.textContent ?? ''),
  );
const installs = () =>
  transport.calls.filter((c) => c.cmd === 'install_update').length;

describe('UpdateReady', () => {
  it('says why a busy app did not restart, and asks again until cancelled', async () => {
    m = await mount(
      <RootStoreProvider store={store}>
        <UpdateReady inline />
      </RootStoreProvider>,
    );
    expect(m.host.textContent).toContain('0.1.7');
    vi.useFakeTimers();
    await click(button(/restart to update/i));
    await act(async () => {
      await Promise.resolve();
    });
    expect(installs()).toBe(1);
    expect(m.host.textContent).toContain(
      'Restarts once pending GitHub actions finish',
    );
    await act(async () => {
      vi.advanceTimersByTime(RESTART_POLL_MS * 2);
    });
    expect(installs()).toBe(3);

    await click(button(/cancel/i));
    await act(async () => {
      vi.advanceTimersByTime(RESTART_POLL_MS * 2);
    });
    expect(installs()).toBe(3);
    expect(button(/restart to update/i)).toBeDefined();
  });

  it('warns how many agents will pause and resume, local ones only', async () => {
    store.sync.pool.put('space', 'a', space({ id: 'a' }));
    store.sync.pool.put('space', 'b', space({ id: 'b', status: 'idle' }));
    store.sync.pool.put(
      'space',
      'rs_1',
      space({
        id: 'rs_1',
        remote: {
          space: 'rs_1',
          host_device: 'd2',
          host_name: 'Studio Mac',
          project_name: 'api',
          started_here: true,
        },
      }),
    );
    m = await mount(
      <RootStoreProvider store={store}>
        <UpdateReady inline />
      </RootStoreProvider>,
    );
    expect(m.host.textContent).toContain(
      '1 agent will pause and resume after the update',
    );
    await click(button(/restart to update/i));
    await act(async () => {
      await Promise.resolve();
    });
    expect(m.host.textContent).toContain(
      'Pausing 1 agent… they resume after the update',
    );
  });

  it('counts and words the warning', () => {
    expect(runningAgents([space({ id: 'a' }), space({ id: 'b', status: 'idle' })])).toBe(1);
    expect(pauseWarning(0)).toBeNull();
    expect(pauseWarning(2)).toBe('2 agents will pause and resume after the update');
    expect(waitingText(0)).toBe('Restarts once pending GitHub actions finish');
    expect(waitingText(3)).toBe('Pausing 3 agents… they resume after the update');
  });
});
