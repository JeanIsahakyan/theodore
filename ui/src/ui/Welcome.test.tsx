/** Finishing onboarding lands in the app; the welcome logo plays over it
 *  only where something animates, and clears itself. */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, mount, settle, type Mounted } from '../test/dom';
import { NO_ACCOUNT } from '../core/accountGate';
import { setTransport } from '../core/transport';
import { RootStore } from '../stores/RootStore';
import { RootStoreProvider } from '../stores/context';
import { FakeTransport } from '../test/fakeTransport';
import { App } from './App';
import { WELCOME_MS } from './Welcome';

let store: RootStore;
let m: Mounted | null = null;

beforeEach(() => {
  localStorage.clear();
  const transport = new FakeTransport();
  setTransport(transport);
  transport.onCall('account_status', () => NO_ACCOUNT);
  transport.onCall('telemetry_status', () => {
    throw new Error('no sink');
  });
  transport.onCall('host_status', () => ({
    host: 'github',
    connected: true,
    login: 'ada',
    source: 'gh',
  }));
  transport.onCall('detect_agents', () => []);
  transport.onCall('track_ui', () => null);
  // The app's views ask the core for things; any answer will do here.
  transport.onCall('refresh_inbox', () => null);
  transport.onCall('viewer', () => ({
    login: 'ada',
    name: null,
    avatar_url: null,
  }));
  store = new RootStore();
  store.ephemeral.setAccount(NO_ACCOUNT);
});

afterEach(() => {
  m?.unmount();
  m = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Onboarding up to its last step, Open Inbox not pressed yet. */
async function toLastStep() {
  m = await mount(
    <RootStoreProvider store={store}>
      <App />
    </RootStoreProvider>,
  );
  await settle();
  expect(m.host.textContent).toContain('Welcome to Theodore');
  while (m.host.querySelector('.onb-next')) {
    await click(m.host.querySelector('.onb-next'));
    await settle();
  }
  const open = [...m.host.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Open Inbox'),
  );
  expect(open).toBeDefined();
  return open!;
}

describe('finishing onboarding', () => {
  it('lands in the app, with no welcome where nothing animates', async () => {
    await click(await toLastStep());
    expect(store.ui.onboarded).toBe(true);
    expect(m!.host.querySelector('.onboarding')).toBeNull();
    expect(m!.host.querySelector('.sidebar')).not.toBeNull();
    expect(document.querySelector('.welcome')).toBeNull();
    expect(m!.host.querySelector('.app-enter')).toBeNull();
  });

  it('plays the welcome over the app once, then clears it', async () => {
    const open = await toLastStep();
    // As in the webview: the Web Animations API is there.
    document.documentElement.animate = (() => ({})) as never;
    vi.useFakeTimers();
    try {
      await click(open);
      // The app is already there under the logo, input and all.
      expect(m!.host.querySelector('.sidebar')).not.toBeNull();
      expect(document.querySelector('.welcome svg')).not.toBeNull();
      expect(m!.host.querySelector('.app-enter')).not.toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(WELCOME_MS);
      });
      expect(document.querySelector('.welcome')).toBeNull();
      expect(m!.host.querySelector('.app-enter')).toBeNull();
    } finally {
      delete (document.documentElement as { animate?: unknown }).animate;
    }
  });

  it('never plays on a launch that starts onboarded', async () => {
    store.ui.finishOnboarding();
    document.documentElement.animate = (() => ({})) as never;
    try {
      m = await mount(
        <RootStoreProvider store={store}>
          <App />
        </RootStoreProvider>,
      );
      await settle();
      expect(m.host.querySelector('.sidebar')).not.toBeNull();
      expect(document.querySelector('.welcome')).toBeNull();
    } finally {
      delete (document.documentElement as { animate?: unknown }).animate;
    }
  });
});
