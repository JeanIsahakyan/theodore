import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, mount, type Mounted } from '../../test/dom';
import { setTransport } from '../../core/transport';
import { RootStore } from '../../stores/RootStore';
import { RootStoreProvider } from '../../stores/context';
import { FakeTransport } from '../../test/fakeTransport';
import { RESTART_POLL_MS, UpdateReady } from './UpdateReady';

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
      'Restarts once agent runs and pending GitHub actions finish',
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
});
