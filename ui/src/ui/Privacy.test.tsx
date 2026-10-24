import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { click, mount, settle, type Mounted } from '../test/dom';
import type { TelemetryStatus } from '../gen/contract';
import { setTransport } from '../core/transport';
import { RootStore } from '../stores/RootStore';
import { RootStoreProvider } from '../stores/context';
import { FakeTransport } from '../test/fakeTransport';
import { nextChoice, PrivacyCard } from './Privacy';

const unchosen: TelemetryStatus = {
  usage_available: true,
  errors_available: true,
  usage: null,
  errors: null,
  events: [],
  never_sent: [],
};

let transport: FakeTransport;
let m: Mounted | null = null;
let sent: unknown[] = [];

beforeEach(() => {
  localStorage.clear();
  sent = [];
  transport = new FakeTransport();
  setTransport(transport);
});

afterEach(() => {
  m?.unmount();
  m = null;
});

async function renderCard(status: TelemetryStatus) {
  let current = status;
  transport.onCall('telemetry_status', () => current);
  transport.onCall('set_telemetry', (args) => {
    const req = args?.req as { usage: boolean; errors: boolean };
    sent.push(req);
    current = { ...current, ...req };
    return current;
  });
  const store = new RootStore();
  m = await mount(
    <RootStoreProvider store={store}>
      <PrivacyCard />
    </RootStoreProvider>,
  );
  await settle();
  return store;
}

const input = (kind: string) =>
  m!.host.querySelector<HTMLInputElement>(`.privacy-${kind} input`);

describe('nextChoice', () => {
  it('keeps the other choice, off when unmade', () => {
    expect(nextChoice({ usage: null, errors: null }, 'usage', true)).toEqual({
      usage: true,
      errors: false,
    });
    expect(nextChoice({ usage: true, errors: false }, 'errors', true)).toEqual({
      usage: true,
      errors: true,
    });
  });
});

describe('PrivacyCard', () => {
  it('shows both off until chosen, and records each switch independently', async () => {
    await renderCard(unchosen);
    expect(input('usage')?.checked).toBe(false);
    expect(input('errors')?.checked).toBe(false);
    await click(input('usage'));
    await settle();
    expect(sent).toEqual([{ usage: true, errors: false }]);
    await click(input('errors'));
    await settle();
    expect(sent[1]).toEqual({ usage: true, errors: true });
    await click(input('usage'));
    await settle();
    expect(sent[2]).toEqual({ usage: false, errors: true });
  });

  it('disables a switch whose sink is not in this build', async () => {
    await renderCard({ ...unchosen, errors_available: false });
    expect(input('errors')?.disabled).toBe(true);
    expect(input('usage')?.disabled).toBe(false);
    expect(m!.host.textContent).toContain('Not configured in this build');
  });

  it("opens What's collected", async () => {
    const store = await renderCard(unchosen);
    await click(m!.host.querySelector('.whats-collected-link'));
    expect(store.ui.modal).toBe('whats-collected');
  });
});
