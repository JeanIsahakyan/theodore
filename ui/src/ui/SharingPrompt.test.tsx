import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TelemetryStatus } from '../gen/contract';
import { setTransport } from '../core/transport';
import { RootStore } from '../stores/RootStore';
import { RootStoreProvider } from '../stores/context';
import { FakeTransport } from '../test/fakeTransport';
import { SharingPrompt, needsSharingChoice } from './SharingPrompt';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no CSS.escape; the modal's keyboard handling asks for it.
globalThis.CSS ??= {
  escape: (s: string) => s.replace(/[^\w-]/g, '\\$&'),
} as unknown as typeof CSS;

const status = (over: Partial<TelemetryStatus> = {}): TelemetryStatus => ({
  usage_available: true,
  errors_available: true,
  usage: null,
  errors: null,
  events: [],
  never_sent: [],
  ...over,
});

describe('needsSharingChoice', () => {
  it('asks while an available sink has no recorded choice', () => {
    expect(needsSharingChoice(status())).toBe(true);
    expect(needsSharingChoice(status({ usage: true }))).toBe(true);
  });

  it('stays quiet once chosen, or when the build sends nothing', () => {
    expect(needsSharingChoice(status({ usage: false, errors: true }))).toBe(
      false,
    );
    expect(
      needsSharingChoice(
        status({ usage_available: false, errors_available: false }),
      ),
    ).toBe(false);
  });
});

describe('SharingPrompt', () => {
  let transport: FakeTransport;
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    transport = new FakeTransport();
    setTransport(transport);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
  });

  async function render() {
    const store = new RootStore();
    await act(async () =>
      root.render(
        <RootStoreProvider store={store}>
          <SharingPrompt />
        </RootStoreProvider>,
      ),
    );
  }

  it('records the choice and goes away', async () => {
    let saved: unknown = null;
    transport.onCall('telemetry_status', () => status());
    transport.onCall('set_telemetry', (args) => {
      saved = args;
      return status({ usage: true, errors: true });
    });
    await render();
    expect(document.body.textContent).toContain('Help improve Theodore');
    const save = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Save',
    );
    await act(async () => save?.click());
    expect(saved).toEqual({ req: { usage: true, errors: true } });
    expect(document.querySelector('.sharing-prompt')).toBeNull();
  });

  it("doesn't show once a choice exists", async () => {
    transport.onCall('telemetry_status', () =>
      status({ usage: false, errors: false }),
    );
    await render();
    expect(document.querySelector('.sharing-prompt')).toBeNull();
  });
});
