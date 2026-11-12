/** "Run on another device": which devices and modes it offers, and what it
 *  sends. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setTransport } from '../../core/transport';
import { RootStore } from '../../stores/RootStore';
import { RootStoreProvider } from '../../stores/context';
import { click, mount, settle, typeInto, type Mounted } from '../../test/dom';
import { device, remoteSpace, status, thisDevice } from '../../test/fleet';
import { FakeTransport } from '../../test/fakeTransport';
import { StartRemoteSpaceModal } from './StartRemoteSpaceModal';

// jsdom has no `CSS.escape`; an open react-aria modal calls it.
(globalThis as { CSS?: { escape?: (s: string) => string } }).CSS ??= {};
globalThis.CSS.escape ??= (s: string) =>
  s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);

let transport: FakeTransport;
let store: RootStore;
let m: Mounted | null = null;

beforeEach(() => {
  transport = new FakeTransport();
  transport.onCall('fleet_start_space', () =>
    remoteSpace({ space: 'rs_new', status: 'starting' }),
  );
  setTransport(transport);
  store = new RootStore();
});

afterEach(() => {
  m?.unmount();
  m = null;
  document.body.innerHTML = '';
});

async function open(devices = [thisDevice(), device()]) {
  store.fleet.setStatus(status({ devices }));
  store.ui.openModal('fleet-start');
  m = await mount(
    <RootStoreProvider store={store}>
      <StartRemoteSpaceModal />
    </RootStoreProvider>,
  );
  await settle();
}

const all = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const texts = (sel: string) => all(sel).map((e) => e.textContent);
const pick = (sel: string, label: string) =>
  all(sel).find((e) => e.textContent === label)!;
const startButton = () =>
  document.querySelector<HTMLButtonElement>('.fleet-start')!;
const goalBox = () =>
  document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Goal"]')!;

describe('Run on another device', () => {
  it('lists only online devices that take remote spaces', async () => {
    await open([
      thisDevice({ accepts_remote: true, projects: [{ id: 'x', name: 'x' }] }),
      device({ device_id: 'ok', name: 'Studio Mac' }),
      device({ device_id: 'off', name: 'Offline Mac', online: false }),
      device({ device_id: 'no', name: 'Closed Mac', accepts_remote: false }),
    ]);
    expect(texts('.fleet-pick-device')).toEqual(['Studio Mac']);
  });

  it('says so when no device can take a space', async () => {
    await open([thisDevice(), device({ online: false })]);
    expect(document.querySelector('.fleet-none')).not.toBeNull();
    expect(startButton().disabled).toBe(true);
  });

  it("offers the device's projects and modes up to its highest", async () => {
    await open([thisDevice(), device({ max_mode: 'plan' })]);
    expect(texts('.fleet-pick-project')).toEqual(['app', 'api']);
    expect(texts('.fleet-pick-mode')).toEqual(['Ask', 'Plan']);
  });

  it('Run is offered only to a device that allows it', async () => {
    await open([thisDevice(), device({ max_mode: 'run' })]);
    expect(texts('.fleet-pick-mode')).toEqual(['Ask', 'Plan', 'Edit', 'Run']);
  });

  it('needs a goal', async () => {
    await open();
    expect(startButton().disabled).toBe(true);
    await typeInto(goalBox(), '  ');
    expect(startButton().disabled).toBe(true);
    await typeInto(goalBox(), 'fix login');
    expect(startButton().disabled).toBe(false);
  });

  it('starts with the device, project, goal and mode picked', async () => {
    await open([
      thisDevice(),
      device({ device_id: 'd2', max_mode: 'run' }),
      device({ device_id: 'd3', name: 'Other Mac', max_mode: 'plan' }),
    ]);
    await click(pick('.fleet-pick-project', 'api'));
    await click(pick('.fleet-pick-mode', 'Run'));
    await typeInto(goalBox(), ' fix login ');
    await click(startButton());
    await settle();
    expect(
      transport.calls.find((c) => c.cmd === 'fleet_start_space')!.args,
    ).toEqual({
      req: {
        device_id: 'd2',
        project_id: 'p2',
        goal: 'fix login',
        mode: 'run',
      },
    });
    expect(store.ui.modal).toBeNull();
    expect(store.ui.route).toEqual({ name: 'fleet-space', id: 'rs_new' });
    expect(store.fleet.spaces.has('rs_new')).toBe(true);
  });

  it('switching to a device with a lower cap brings the mode down', async () => {
    await open([
      thisDevice(),
      device({ device_id: 'd2', max_mode: 'run' }),
      device({ device_id: 'd3', name: 'Other Mac', max_mode: 'plan' }),
    ]);
    await click(pick('.fleet-pick-mode', 'Run'));
    await click(pick('.fleet-pick-device', 'Other Mac'));
    expect(texts('.fleet-pick-mode')).toEqual(['Ask', 'Plan']);
    await typeInto(goalBox(), 'x');
    await click(startButton());
    await settle();
    const req = transport.calls.find((c) => c.cmd === 'fleet_start_space')!.args
      ?.req as { device_id: string; mode: string };
    expect(req.device_id).toBe('d3');
    expect(req.mode).toBe('plan');
  });

  it('a refused start keeps the form', async () => {
    transport.onCall('fleet_start_space', () => {
      throw { code: 'fleet.untrusted_device', message: 'not trusted' };
    });
    await open();
    await typeInto(goalBox(), 'fix login');
    await click(startButton());
    await settle();
    expect(store.ui.modal).toBe('fleet-start');
    expect(goalBox().value).toBe('fix login');
  });
});
