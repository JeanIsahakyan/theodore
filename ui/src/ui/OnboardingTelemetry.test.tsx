/** Onboarding's sharing step: shown only when the build can send
 *  anything, and the choice is recorded before moving on. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { click, mount, settle, type Mounted } from '../test/dom';
import type { TelemetryStatus } from '../gen/contract';
import { NO_ACCOUNT } from '../core/accountGate';
import { setTransport } from '../core/transport';
import { RootStore } from '../stores/RootStore';
import { RootStoreProvider } from '../stores/context';
import { FakeTransport } from '../test/fakeTransport';
import { App } from './App';

const status: TelemetryStatus = {
  usage_available: true,
  errors_available: true,
  usage: null,
  errors: null,
  events: [],
  never_sent: [],
};

let transport: FakeTransport;
let store: RootStore;
let m: Mounted | null = null;

beforeEach(() => {
  localStorage.clear();
  transport = new FakeTransport();
  setTransport(transport);
  transport.onCall('account_status', () => NO_ACCOUNT);
  transport.onCall('host_status', () => ({
    host: 'github',
    connected: true,
    login: 'ada',
    source: 'gh',
  }));
  transport.onCall('detect_agents', () => []);
  transport.onCall('track_ui', () => null);
  store = new RootStore();
  store.ephemeral.setAccount(NO_ACCOUNT);
});

afterEach(() => {
  m?.unmount();
  m = null;
});

async function render() {
  m = await mount(
    <RootStoreProvider store={store}>
      <App />
    </RootStoreProvider>,
  );
  await settle();
}

const tracked = () =>
  transport.calls
    .filter((c) => c.cmd === 'track_ui')
    .map((c) => (c.args?.event as { step: string }).step);

describe('Onboarding: Help improve Theodore', () => {
  it('saves the checkbox values before moving on', async () => {
    transport.onCall('telemetry_status', () => status);
    let finish: (s: TelemetryStatus) => void = () => {};
    transport.onCall(
      'set_telemetry',
      () => new Promise<TelemetryStatus>((r) => (finish = r)),
    );
    await render();
    const host = m!.host;
    expect(host.textContent).toContain('Help improve Theodore');
    expect(host.textContent).toContain('Step 1 of 5');
    const usage = host.querySelector<HTMLInputElement>('.share-usage input');
    const errors = host.querySelector<HTMLInputElement>('.share-errors input');
    expect(usage?.checked).toBe(true);
    expect(errors?.checked).toBe(true);

    await click(usage);
    await click(host.querySelector('.onb-next'));
    const calls = transport.calls.filter((c) => c.cmd === 'set_telemetry');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual({ req: { usage: false, errors: true } });
    // Still here until the core has recorded it.
    expect(host.textContent).toContain('Help improve Theodore');

    finish({ ...status, usage: false, errors: true });
    await settle();
    expect(host.textContent).toContain('Connect GitHub');
    expect(tracked()).toEqual(['telemetry', 'github']);
  });

  it('is left out when nothing can be sent', async () => {
    transport.onCall('telemetry_status', () => ({
      ...status,
      usage_available: false,
      errors_available: false,
    }));
    await render();
    expect(m!.host.textContent).toContain('Step 1 of 4');
    expect(m!.host.textContent).toContain('Connect GitHub');
    expect(m!.host.textContent).not.toContain('Help improve Theodore');
  });
});
