/** Settings → Devices: what each control sends, the trust confirmation,
 *  and the page staying hidden where there is no fleet. */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FleetStatus } from '../../gen/contract';
import { setTransport } from '../../core/transport';
import { RootStore } from '../../stores/RootStore';
import { RootStoreProvider } from '../../stores/context';
import { click, mount, settle, typeInto, type Mounted } from '../../test/dom';
import { device, status, thisDevice } from '../../test/fleet';
import { FakeTransport } from '../../test/fakeTransport';
import { SettingsNav } from '../Settings';
import { DevicesPage } from './DevicesPage';

let transport: FakeTransport;
let store: RootStore;
let m: Mounted | null = null;
let current: FleetStatus;

beforeEach(() => {
  transport = new FakeTransport();
  current = status();
  const reply =
    (patch: (s: FleetStatus, req: never) => FleetStatus) =>
    (args?: Record<string, unknown>) => {
      current = patch(current, args?.req as never);
      return current;
    };
  transport.onCall(
    'fleet_set_settings',
    reply((s, req: Record<string, unknown>) => ({
      ...s,
      ...Object.fromEntries(Object.entries(req).filter(([, v]) => v != null)),
    })),
  );
  transport.onCall(
    'fleet_trust_device',
    reply((s, req: { device_id: string; trusted: boolean }) => ({
      ...s,
      devices: s.devices.map((d) =>
        d.device_id === req.device_id ? { ...d, trusted: req.trusted } : d,
      ),
    })),
  );
  setTransport(transport);
  store = new RootStore();
});

afterEach(() => {
  m?.unmount();
  m = null;
});

async function render(s: FleetStatus | null = current) {
  if (s) {
    current = s;
    store.fleet.setStatus(s);
  }
  m = await mount(
    <RootStoreProvider store={store}>
      <DevicesPage />
    </RootStoreProvider>,
  );
  await settle();
}

const q = <T extends Element = HTMLElement>(sel: string) =>
  m!.host.querySelector<T>(sel);
const req = (cmd: string) =>
  transport.calls.filter((c) => c.cmd === cmd).map((c) => c.args?.req);
const button = (label: string) =>
  [...m!.host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;

describe('where there is no fleet', () => {
  it('the page shows nothing', async () => {
    await render(status({ available: false }));
    expect(m!.host.textContent).toBe('');
  });

  it('Settings does not list Devices', async () => {
    store.fleet.setStatus(status({ available: false }));
    m = await mount(
      <RootStoreProvider store={store}>
        <SettingsNav page="account" />
      </RootStoreProvider>,
    );
    await settle();
    expect(m.host.textContent).toContain('Agents');
    expect(m.host.textContent).not.toContain('Devices');
  });

  it('Settings lists Devices once there is one', async () => {
    store.fleet.setStatus(status());
    m = await mount(
      <RootStoreProvider store={store}>
        <SettingsNav page="account" />
      </RootStoreProvider>,
    );
    await settle();
    expect(m.host.textContent).toContain('Devices');
  });
});

describe('this device', () => {
  it('shows its name, fingerprint and that it is connected', async () => {
    await render();
    expect(
      q<HTMLInputElement>('input[aria-label="This device\'s name"]')!.value,
    ).toBe('Laptop');
    expect(q('.fleet-this')!.textContent).toContain('1111 2222 3333 4444');
    expect(q('.fleet-state')!.textContent).toBe('Connected');
  });

  it('says why it is not connected', async () => {
    await render(status({ connected: false, error: 'cloud unreachable' }));
    expect(q('.fleet-state')!.textContent).toBe('Connecting…');
    expect(q('.fleet-error')!.textContent).toBe('cloud unreachable');
  });

  it('Connect this device sends enabled', async () => {
    await render();
    await click(q('input[aria-label="Connect this device"]'));
    await settle();
    expect(req('fleet_set_settings')).toEqual([{ enabled: false }]);
    expect(store.fleet.enabled).toBe(false);
  });

  it('the remote switch sends accept_remote, and shows the mode choice once on', async () => {
    await render();
    expect(q('[aria-label="Highest mode"]')).toBeNull();
    await click(
      q('input[aria-label="Let my trusted devices run spaces here"]'),
    );
    await settle();
    expect(req('fleet_set_settings')).toEqual([{ accept_remote: true }]);
    expect(q('[aria-label="Highest mode"]')).not.toBeNull();
  });

  it('Highest mode sends max_mode, with a warning on Run only', async () => {
    await render(status({ accept_remote: true }));
    expect(q('.fleet-run-warning')).toBeNull();
    const run = [
      ...m!.host.querySelectorAll('[aria-label="Highest mode"] button'),
    ].find((b) => b.textContent === 'Run')!;
    await click(run);
    await settle();
    expect(req('fleet_set_settings')).toEqual([{ max_mode: 'run' }]);
    expect(q('.fleet-run-warning')!.textContent).toContain('any command');
  });

  it('a new name is saved on blur, an unchanged one is not', async () => {
    await render();
    const input = q<HTMLInputElement>(
      'input[aria-label="This device\'s name"]',
    )!;
    await act(async () => input.focus());
    await typeInto(input, 'Laptop');
    await act(async () => input.blur());
    await settle();
    expect(req('fleet_set_settings')).toEqual([]);

    await act(async () => input.focus());
    await typeInto(input, '  Work laptop ');
    await act(async () => input.blur());
    await settle();
    expect(req('fleet_set_settings')).toEqual([{ name: 'Work laptop' }]);
  });
});

describe('the device list', () => {
  it('marks this device and describes the others', async () => {
    await render(
      status({
        devices: [
          thisDevice(),
          device({ accepts_remote: true, max_mode: 'plan' }),
          device({
            device_id: 'd3',
            name: 'Build box',
            os: 'linux',
            online: false,
            last_seen_ms: 0,
            accepts_remote: false,
          }),
        ],
      }),
    );
    const rows = [...m!.host.querySelectorAll('.fleet-device')];
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain('This device');
    expect(rows[0]!.querySelector('.fleet-trust')).toBeNull();
    expect(rows[1]!.textContent).toContain('Studio Mac');
    expect(rows[1]!.textContent).toContain('macOS');
    expect(rows[1]!.textContent).toContain('online');
    expect(rows[1]!.textContent).toContain('runs spaces up to Plan');
    expect(rows[1]!.textContent).toContain('a1b2 c3d4 e5f6 0718');
    expect(rows[1]!.querySelector('[aria-label="Online"]')).not.toBeNull();
    expect(rows[2]!.textContent).toContain('Linux');
    expect(rows[2]!.textContent).toContain('never seen');
    expect(rows[2]!.textContent).toContain('does not run remote spaces');
    expect(rows[2]!.querySelector('[aria-label="Offline"]')).not.toBeNull();
  });

  it('Trust asks to compare the fingerprint before it trusts anything', async () => {
    await render();
    await click(q('.fleet-trust'));
    const confirm = q('.fleet-confirm')!;
    expect(confirm.textContent).toContain(
      'Make sure Studio Mac shows the same fingerprint',
    );
    expect(confirm.textContent).toContain('a1b2 c3d4 e5f6 0718');
    expect(req('fleet_trust_device')).toEqual([]);

    await click(q('.fleet-confirm-trust'));
    await settle();
    expect(req('fleet_trust_device')).toEqual([
      { device_id: 'd2', trusted: true },
    ]);
    expect(q('.fleet-confirm')).toBeNull();
    expect(q('.fleet-untrust')).not.toBeNull();
  });

  it('cancelling the confirmation trusts nothing', async () => {
    await render();
    await click(q('.fleet-trust'));
    await click(q('.fleet-confirm-cancel'));
    expect(q('.fleet-confirm')).toBeNull();
    expect(req('fleet_trust_device')).toEqual([]);
  });

  it('Untrust goes straight through', async () => {
    await render(
      status({ devices: [thisDevice(), device({ trusted: true })] }),
    );
    await click(q('.fleet-untrust'));
    await settle();
    expect(req('fleet_trust_device')).toEqual([
      { device_id: 'd2', trusted: false },
    ]);
    expect(q('.fleet-trust')).not.toBeNull();
  });

  it('Run on another device opens the start dialog, only if one can take it', async () => {
    await render(status({ devices: [thisDevice(), device()] }));
    expect(button('Run on another device…')!.disabled).toBe(false);
    await click(button('Run on another device…'));
    expect(store.ui.modal).toBe('fleet-start');
  });

  it('Run on another device is off when none can take a space', async () => {
    await render(
      status({ devices: [thisDevice(), device({ accepts_remote: false })] }),
    );
    expect(button('Run on another device…')!.disabled).toBe(true);
  });
});
