/** The fleet's chips in the tab bar: auto mode on (with its popover), and
 *  the reminder of decisions put away. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetAutoOn } from '../../gen/contract';
import { setTransport } from '../../core/transport';
import { RootStore } from '../../stores/RootStore';
import { RootStoreProvider } from '../../stores/context';
import { click, mount, settle, type Mounted } from '../../test/dom';
import {
  confirmRequest,
  device,
  status,
  thisDevice,
  trustNeeded,
} from '../../test/fleet';
import { FakeTransport } from '../../test/fakeTransport';
import { FleetChrome } from './FleetChrome';

// jsdom has no CSS.escape; the popover's keyboard handling asks for it.
globalThis.CSS ??= {
  escape: (s: string) => s.replace(/[^\w-]/g, '\\$&'),
} as unknown as typeof CSS;

let transport: FakeTransport;
let store: RootStore;
let m: Mounted | null = null;

beforeEach(() => {
  transport = new FakeTransport();
  transport.onCall('fleet_set_auto', () => status({ autos: [] }));
  setTransport(transport);
  store = new RootStore();
  store.fleet.setStatus(status());
});

afterEach(() => {
  m?.unmount();
  m = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

/** Pins the clock to a local midday, so an end an hour away is the same day
 *  and one a day away is not, whatever the hour the test runs at. Timers
 *  keep running (`settle` waits on them). */
const NOON = new Date(2026, 5, 15, 12, 0, 0).getTime();
const pinNoon = () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOON);
};
const localTime = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const localDay = (ms: number) =>
  new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });

async function render() {
  m = await mount(
    <RootStoreProvider store={store}>
      <FleetChrome />
    </RootStoreProvider>,
  );
  await settle();
}

const q = <T extends Element = HTMLElement>(sel: string) =>
  document.querySelector<T>(sel);
const calls = (cmd: string) =>
  transport.calls.filter((c) => c.cmd === cmd).map((c) => c.args);

const here = (over: Partial<FleetAutoOn> = {}): FleetAutoOn => ({
  device_id: 'cl',
  device_name: 'Claude',
  auto: 'full',
  until_ms: Date.now() + 3_600_000,
  ...over,
});

describe('the auto mode chip', () => {
  it('shows nothing while no auto mode is on', async () => {
    store.fleet.setStatus(
      status({ autos: [here({ until_ms: Date.now() - 1 })] }),
    );
    await render();
    expect(q('.fleet-auto-chip')).toBeNull();
    expect(m!.host.textContent).toBe('');
  });

  it('shows the mode and its end, and goes when turned off', async () => {
    pinNoon();
    await render();
    expect(q('.fleet-auto-chip')).toBeNull();
    const until = NOON + 3_600_000;
    store.fleet.setStatus(status({ autos: [here({ until_ms: until })] }));
    await settle();
    // Same day: the time alone.
    expect(q('.fleet-auto-chip-label')!.textContent).toBe(
      `Full auto · ${localTime(until)}`,
    );
    store.fleet.setStatus(status({ autos: [] }));
    await settle();
    expect(q('.fleet-auto-chip')).toBeNull();
  });

  it('dates an end that falls on another day', async () => {
    pinNoon();
    const until = NOON + 24 * 3_600_000;
    store.fleet.setStatus(status({ autos: [here({ until_ms: until })] }));
    await render();
    expect(q('.fleet-auto-chip-label')!.textContent).toBe(
      `Full auto · ${localDay(until)}, ${localTime(until)}`,
    );
  });

  it('names no end for one until turned off', async () => {
    store.fleet.setStatus(
      status({ autos: [here({ auto: 'edit', until_ms: null })] }),
    );
    await render();
    expect(q('.fleet-auto-chip-label')!.textContent).toBe('Auto Edit');
  });

  it('stays hidden where there is no fleet', async () => {
    store.fleet.setStatus(status({ available: false, autos: [here()] }));
    await render();
    expect(m!.host.textContent).toBe('');
  });

  it("lists this computer's and another's, each turned off where it is", async () => {
    store.fleet.setStatus(
      status({
        autos: [here({ auto: 'edit', until_ms: null })],
        devices: [
          thisDevice(),
          device({
            trusted: true,
            mcp_auto: [
              {
                device_id: 'cl',
                name: 'Claude (MCP)',
                auto: 'full',
                until_ms: null,
              },
            ],
          }),
        ],
      }),
    );
    await render();
    // The strongest names the chip.
    expect(q('.fleet-auto-chip-label')!.textContent).toBe('Full auto +1');
    await click(q('.fleet-auto-chip'));
    await settle();
    const rows = [...document.querySelectorAll('.fleet-auto-entry')];
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining(
        'This computerClaude: Auto Edit until turned off',
      ),
      expect.stringContaining(
        'Studio MacClaude (MCP): Full auto until turned off',
      ),
    ]);

    await click(rows[1]!.querySelector('.fleet-auto-off'));
    await settle();
    expect(calls('fleet_set_auto')).toEqual([
      {
        req: {
          device_id: 'cl',
          auto: 'off',
          until_ms: null,
          host_device: 'd2',
        },
      },
    ]);
  });

  it('Turn off here sends no host', async () => {
    store.fleet.setStatus(status({ autos: [here()] }));
    await render();
    await click(q('.fleet-auto-chip'));
    await settle();
    await click(q('.fleet-auto-entry .fleet-auto-off'));
    await settle();
    expect(calls('fleet_set_auto')).toEqual([
      {
        req: {
          device_id: 'cl',
          auto: 'off',
          until_ms: null,
          host_device: null,
        },
      },
    ]);
    expect(q('.fleet-auto-chip')).toBeNull();
  });

  it("can't turn off one on a computer that's offline", async () => {
    store.fleet.setStatus(
      status({
        devices: [
          thisDevice(),
          device({
            trusted: true,
            online: false,
            mcp_auto: [
              { device_id: 'cl', name: 'Claude', auto: 'edit', until_ms: null },
            ],
          }),
        ],
      }),
    );
    await render();
    await click(q('.fleet-auto-chip'));
    await settle();
    const row = q('.fleet-auto-entry')!;
    expect(row.textContent).toContain('Studio Mac is offline.');
    expect(
      row.querySelector('.fleet-auto-off')!.hasAttribute('disabled') ||
        row.querySelector('.fleet-auto-off')!.getAttribute('data-disabled') ===
          'true',
    ).toBe(true);
  });

  it('links to Settings → Devices', async () => {
    store.fleet.setStatus(status({ autos: [here()] }));
    await render();
    await click(q('.fleet-auto-chip'));
    await settle();
    await click(q('.fleet-auto-settings'));
    await settle();
    expect(store.ui.route).toEqual({ name: 'settings', page: 'devices' });
  });
});

describe('the waiting reminder', () => {
  it('shows only while decisions are put away, and opens them again', async () => {
    store.fleet.handle({ type: 'fleet_confirm', request: confirmRequest() });
    store.fleet.handle({ type: 'fleet_trust_needed', request: trustNeeded() });
    await render();
    // The dialog is up: no reminder.
    expect(q('.fleet-waiting')).toBeNull();

    store.fleet.putAwayPrompts(['confirm:req1', 'trust:d2']);
    await settle();
    expect(q('.fleet-waiting')!.textContent).toBe('2 waiting');

    await click(q('.fleet-waiting'));
    await settle();
    expect(store.fleet.promptsAway.size).toBe(0);
    expect(q('.fleet-waiting')).toBeNull();
  });

  it('goes when what waited is answered elsewhere', async () => {
    store.fleet.handle({ type: 'fleet_confirm', request: confirmRequest() });
    store.fleet.putAwayPrompts(['confirm:req1']);
    await render();
    expect(q('.fleet-waiting')!.textContent).toBe('1 waiting');
    store.fleet.handle({ type: 'fleet_confirm_done', id: 'req1' });
    await settle();
    expect(q('.fleet-waiting')).toBeNull();
  });
});
