/** New space's "Run on" (docs/fleet.md): the computers it can start a
 *  space on, what it sends to one, and where it lands once started. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCommandFailureHandler } from '../../core/api';
import { setTransport } from '../../core/transport';
import { RootStore } from '../../stores/RootStore';
import { RootStoreProvider } from '../../stores/context';
import { click, mount, settle, typeInto, type Mounted } from '../../test/dom';
import { FakeTransport } from '../../test/fakeTransport';
import {
  device as anyDevice,
  remoteSpace,
  status,
  thisDevice,
} from '../../test/fleet';
import type { FleetDevice } from '../../gen/contract';
import { resetAgentModels } from '../useAgentModels';
import { NewSpaceModal } from './SpacePage';
import { RUN_ELSEWHERE } from './spaces';

// jsdom has no `CSS.escape`; an open react-aria modal calls it.
(globalThis as { CSS?: { escape?: (s: string) => string } }).CSS ??= {};
globalThis.CSS.escape ??= (s: string) =>
  s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);

/** Trusted here: only those can be started on. */
const device = (over: Partial<FleetDevice> = {}) =>
  anyDevice({ trusted: true, ...over });

const PROJECT = {
  id: 'local:app',
  repo: { host: 'local', owner: '', name: 'app' },
  path: '/src/app',
  default_branch: 'main',
  status: 'ready',
  error: null,
};

let transport: FakeTransport;
let store: RootStore;
let m: Mounted | null = null;

beforeEach(() => {
  resetAgentModels();
  transport = new FakeTransport();
  transport.onCall('detect_agents', () => [
    { id: 'claude', installed: true, version: '1', path: '/bin/claude' },
  ]);
  transport.onCall('agent_models', () => []);
  transport.onCall('project_skills', () => []);
  transport.onCall('create_space', () => ({ id: 's1' }));
  transport.onCall('fleet_start_space', () =>
    remoteSpace({ space: 'rs_new', status: 'starting' }),
  );
  setTransport(transport);
  store = new RootStore();
  store.sync.pool.put('project', PROJECT.id, PROJECT);
});

afterEach(() => {
  m?.unmount();
  m = null;
  document.body.innerHTML = '';
});

async function open(
  devices: FleetDevice[] = [thisDevice(), device()],
  targets: string[] = [],
) {
  m?.unmount();
  store.fleet.setStatus(status({ devices }));
  store.ui.openModal('new-space', targets);
  m = await mount(
    <RootStoreProvider store={store}>
      <NewSpaceModal />
    </RootStoreProvider>,
  );
  await settle();
  await settle();
}

const box = () => document.querySelector('textarea')!;
const createButton = () =>
  [...document.querySelectorAll('button')].find((b) =>
    b.textContent?.trim().startsWith('Create'),
  ) as HTMLButtonElement;
const chip = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const menuItems = () =>
  [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].map(
    (e) => e.textContent ?? '',
  );
async function pickIn(label: string, item: RegExp) {
  await click(chip(label));
  await settle();
  const row = [...document.querySelectorAll('[role^="menuitem"]')].find((e) =>
    item.test(e.textContent ?? ''),
  );
  await click(row);
  await settle();
}
const started = () =>
  transport.calls
    .filter((c) => c.cmd === 'fleet_start_space')
    .map((c) => c.args?.req);

describe('Run on', () => {
  it('is not offered with no other computer to run on', async () => {
    await open([thisDevice(), device({ online: false })]);
    expect(chip('Run on')).toBeNull();
    await open([thisDevice(), device({ trusted: false })]);
    expect(chip('Run on')).toBeNull();
  });

  it('lists this device, then the computers that can take a space', async () => {
    await open([
      thisDevice(),
      device({ device_id: 'ok', name: 'Studio Mac' }),
      device({ device_id: 'no', name: 'Busy Mac', accepts_remote: false }),
      device({ device_id: 'ph', name: 'Phone', kind: 'mobile' }),
    ]);
    expect(chip('Run on')!.textContent).toContain('This device');
    await click(chip('Run on'));
    await settle();
    const items = menuItems();
    expect(items[0]).toContain('This device');
    expect(items.some((t) => t.includes('Studio Mac'))).toBe(true);
    expect(items.some((t) => t.includes('Busy Mac'))).toBe(false);
    expect(items.some((t) => t.includes('Phone'))).toBe(false);
  });

  it('starts it on the device picked, then opens it as a space', async () => {
    await open([thisDevice(), device({ max_mode: 'run' })]);
    await pickIn('Run on', /Studio Mac/);
    // Its projects, not this device's; no "Start from".
    expect(chip('Project')!.textContent).toContain('app');
    expect(chip('Start from')).toBeNull();
    // A space elsewhere starts from its goal.
    expect(createButton().disabled).toBe(true);
    await pickIn('Project', /api/);
    await pickIn('Mode', /Run/);
    await typeInto(box(), 'Fix the login');
    await click(createButton());
    await settle();

    expect(started()).toEqual([
      {
        device_id: 'd2',
        project_id: 'p2',
        goal: 'Fix the login',
        mode: 'run',
        // It lists no agents: its own defaults run.
        agent: null,
        model: null,
        effort: null,
      },
    ]);
    expect(transport.calls.some((c) => c.cmd === 'create_space')).toBe(false);
    expect(store.ui.modal).toBeNull();
    expect(store.ui.route).toEqual({ name: 'space', id: 'rs_new' });
    expect(store.fleet.spaces.has('rs_new')).toBe(true);
  });

  it('offers no mode above what the device allows', async () => {
    await open([thisDevice(), device({ max_mode: 'plan' })], [RUN_ELSEWHERE]);
    expect(chip('Run on')!.textContent).toContain('Studio Mac');
    // Edit, the default, brought down to the cap.
    expect(chip('Mode')!.textContent).toContain('Plan');
    await click(chip('Mode'));
    await settle();
    expect(
      menuItems().map((t) => t.match(/^(Ask|Plan|Edit|Run)/)?.[1]),
    ).toEqual(['Ask', 'Plan']);
  });

  it('back on this device, creates it here as before', async () => {
    await open([thisDevice(), device()], [RUN_ELSEWHERE]);
    await pickIn('Run on', /This device/);
    await typeInto(box(), 'Fix the login');
    await click(createButton());
    await settle();
    expect(started()).toEqual([]);
    expect(transport.calls.some((c) => c.cmd === 'create_space')).toBe(true);
  });

  it("offers the device's own agents, and sends only what was picked", async () => {
    const model = (id: string, label: string, efforts: string[]) => ({
      id,
      label,
      description: null,
      efforts,
      default_effort: null,
      older: false,
    });
    const agents: FleetDevice['agents'] = [
      {
        id: 'claude',
        label: 'Claude',
        default_model: 'host-opus',
        default_effort: 'high',
        models: [model('host-opus', 'Host Opus', ['low', 'high'])],
      },
      {
        id: 'codex',
        label: 'Codex',
        default_model: 'gpt-host',
        default_effort: null,
        models: [model('gpt-host', 'GPT Host', [])],
      },
    ];
    // A device that lists none (older): no chip there.
    await open([thisDevice(), device()], [RUN_ELSEWHERE]);
    expect(chip('Model')).toBeNull();

    await open([thisDevice(), device({ agents })], [RUN_ELSEWHERE]);
    expect(chip('Model')!.textContent).toBe('Host Opus High');
    await typeInto(box(), 'Fix the login');
    await click(createButton());
    await settle();
    // Nothing picked: its defaults run.
    expect(started()).toMatchObject([
      { agent: null, model: null, effort: null },
    ]);

    await open([thisDevice(), device({ agents })], [RUN_ELSEWHERE]);
    await pickIn('Model', /^GPT Host/);
    expect(chip('Model')!.textContent).toBe('GPT Host');
    await typeInto(box(), 'Fix the login');
    await click(createButton());
    await settle();
    expect(started()[1]).toMatchObject({
      agent: 'codex',
      model: null,
      effort: null,
    });
  });

  it('stays open when the device refuses', async () => {
    const toast = vi.fn();
    setCommandFailureHandler(toast);
    transport.onCall('fleet_start_space', () => {
      throw { code: 'fleet.untrusted_device', message: 'not trusted' };
    });
    await open([thisDevice(), device()], [RUN_ELSEWHERE]);
    await typeInto(box(), 'Fix the login');
    await click(createButton());
    await settle();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(store.ui.modal).toBe('new-space');
    expect(box().value).toBe('Fix the login');
  });
});
