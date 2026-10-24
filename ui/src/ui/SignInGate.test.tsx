/** The account gate in the real `App` (plan §6.12): signed out where
 *  sign-in is required, the window holds the sign-in and nothing else;
 *  onboarding starts with it and can't move on until signed in. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountStatus } from '../gen/contract';
import { setTransport } from '../core/transport';
import { RootStore } from '../stores/RootStore';
import { RootStoreProvider } from '../stores/context';
import { FakeTransport } from '../test/fakeTransport';
import { App } from './App';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
// HeroUI's toast region asks for the reduced-motion query; jsdom has none.
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const signedOut: AccountStatus = {
  available: true,
  required: true,
  user: null,
  session_ended: false,
};
const signedIn: AccountStatus = {
  ...signedOut,
  user: { id: 'u', email: 'ada@example.com', name: 'Ada', avatar_url: null },
};

let transport: FakeTransport;
let store: RootStore;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  transport = new FakeTransport();
  setTransport(transport);
  transport.onCall('account_status', () => store.ephemeral.account);
  transport.onCall('host_status', () => ({
    host: 'github',
    connected: true,
    login: 'ada',
    source: 'gh',
  }));
  transport.onCall('detect_agents', () => []);
  store = new RootStore();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function render() {
  await act(async () =>
    root.render(
      <RootStoreProvider store={store}>
        <App />
      </RootStoreProvider>,
    ),
  );
}

async function setAccount(s: AccountStatus) {
  await act(async () => store.ephemeral.setAccount(s));
}

const called = (cmd: string) => transport.calls.some((c) => c.cmd === cmd);
const buttons = () => [...host.querySelectorAll('button')];

describe('App behind the account gate', () => {
  it('shows only the sign-in once onboarded and signed out', async () => {
    store.ui.finishOnboarding();
    await setAccount(signedOut);
    await render();
    expect(host.querySelector('.sign-in-gate')).not.toBeNull();
    expect(host.textContent).toContain('Sign in to Theodore');
    expect(host.querySelector('.sidebar')).toBeNull();
    expect(host.querySelector('.onboarding')).toBeNull();
    expect(buttons().some((b) => /skip/i.test(b.textContent ?? ''))).toBe(
      false,
    );
  });

  it('says so when the session ended', async () => {
    store.ui.finishOnboarding();
    await setAccount({ ...signedOut, session_ended: true });
    await render();
    expect(host.textContent).toContain('Your session ended — sign in again');
  });

  it('keeps shortcuts and the palette inert', async () => {
    store.ui.finishOnboarding();
    await setAccount(signedOut);
    await render();
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', metaKey: true }),
      );
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }));
    });
    expect(store.ui.modal).toBeNull();
  });

  it('opens the app on signing in, and the gate returns on sign-out', async () => {
    store.ui.finishOnboarding();
    await setAccount(signedOut);
    await render();
    expect(host.querySelector('.sign-in-gate')).not.toBeNull();
    // The app's views ask the core for things; any answer will do here.
    transport.onCall('refresh_inbox', () => null);
    transport.onCall('viewer', () => ({
      login: 'ada',
      name: null,
      avatar_url: null,
    }));
    await setAccount(signedIn);
    expect(host.querySelector('.sign-in-gate')).toBeNull();
    await setAccount(signedOut);
    expect(host.querySelector('.sign-in-gate')).not.toBeNull();
  });

  it('shows nothing before the account status arrives', async () => {
    store.ui.finishOnboarding();
    await render();
    expect(host.querySelector('.sign-in-gate')).toBeNull();
    expect(host.querySelector('.sidebar')).toBeNull();
  });
});

describe('Onboarding behind the account gate', () => {
  it('starts on the sign-in, without Skip, and runs nothing else', async () => {
    await setAccount(signedOut);
    await render();
    expect(host.querySelector('.onboarding')).not.toBeNull();
    expect(host.textContent).toContain('Step 1 of 5');
    expect(host.textContent).toContain('Sign in to Theodore');
    const next = host.querySelector<HTMLButtonElement>('.onb-next');
    expect(next?.disabled).toBe(true);
    expect(next?.textContent).toBe('Next');
    expect(buttons().some((b) => /skip/i.test(b.textContent ?? ''))).toBe(
      false,
    );
    expect(called('host_status')).toBe(false);
    expect(called('detect_agents')).toBe(false);
  });

  it('moves on once signed in', async () => {
    await setAccount(signedOut);
    await render();
    await setAccount(signedIn);
    await act(async () => {
      await Promise.resolve();
    });
    const next = host.querySelector<HTMLButtonElement>('.onb-next');
    expect(next?.disabled).toBe(false);
    expect(called('host_status')).toBe(true);
    expect(called('detect_agents')).toBe(true);
  });

  it('leaves the sign-in out without a configured account', async () => {
    await setAccount({
      available: false,
      required: false,
      user: null,
      session_ended: false,
    });
    await render();
    expect(host.textContent).toContain('Step 1 of 4');
    expect(host.textContent).toContain('Connect GitHub');
  });
});
