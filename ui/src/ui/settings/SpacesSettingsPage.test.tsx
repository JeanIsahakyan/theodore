/** Settings → Spaces: the switch, the defaults for every project, the
 *  global config file — and no per-project list any more. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Project } from '../../gen/contract';
import { setTransport } from '../../core/transport';
import { RootStore } from '../../stores/RootStore';
import { RootStoreProvider } from '../../stores/context';
import { FakeTransport } from '../../test/fakeTransport';
import { click, mount, settle, typeInto, type Mounted } from '../../test/dom';
import { SpacesSettingsPage } from './SpacesSettingsPage';

let m: Mounted | null = null;
let transport: FakeTransport;
let store: RootStore;

beforeEach(() => {
  transport = new FakeTransport();
  transport.onCall('global_config', () => ({
    path: '/home/u/.theodore/config.yaml',
    exists: true,
  }));
  transport.onCall('transact', () => ({ status: 'ok', last_sync_id: 1 }));
  setTransport(transport);
  store = new RootStore();
  store.sync.pool.put('project', 'github:acme/web', {
    id: 'github:acme/web',
    repo: { host: 'github', owner: 'acme', name: 'web' },
    status: 'ready',
    added_at: 1,
  } as Project);
});

afterEach(() => {
  m?.unmount();
  m = null;
});

const render = async () => {
  m = await mount(
    <RootStoreProvider store={store}>
      <SpacesSettingsPage />
    </RootStoreProvider>,
  );
  await settle();
};

const labels = () =>
  [...m!.host.querySelectorAll('.set-row .text-sm.font-medium')].map(
    (e) => e.textContent,
  );
const lastTx = () => {
  const c = [...transport.calls].reverse().find((c) => c.cmd === 'transact');
  return (c?.args as { tx: { ops: unknown[] } } | undefined)?.tx.ops[0];
};

describe('Settings → Spaces', () => {
  it('lists the notification switch and the defaults for every project', async () => {
    await render();
    expect(labels()).toEqual([
      'Notify when a turn ends',
      'Auto-archive after (days)',
      'Archive merged spaces automatically',
      'Max sub-spaces per space',
      'Max sub-space depth',
      'Ask timeout (seconds)',
    ]);
    const t = m!.host.textContent ?? '';
    expect(t).toContain('Defaults for every project');
    expect(t).toContain('/home/u/.theodore/config.yaml');
  });

  it('points at each project’s settings instead of listing their configs', async () => {
    await render();
    expect(m!.host.querySelector('.config-project')).toBeNull();
    expect(m!.host.textContent).not.toContain('acme/web');
    expect(
      m!.host.querySelector('.config-projects-hint')?.textContent,
    ).toContain('Project settings → Spaces');
    expect(transport.calls.some((c) => c.cmd === 'project_config')).toBe(false);
  });

  it('writes the user scope, with the built-in default as the placeholder', async () => {
    await render();
    const inputs = [...m!.host.querySelectorAll<HTMLInputElement>('input')];
    const depth = inputs.find(
      (i) => i.getAttribute('aria-label') === 'Max sub-space depth',
    )!;
    expect(depth.placeholder).toBe('2');
    await typeInto(depth, '4');
    depth.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await settle();
    expect(lastTx()).toMatchObject({
      op: 'create',
      model: 'setting',
      id: 'user:spaces.max_depth',
      data: { key: 'spaces.max_depth', scope: 'user', value: 4 },
    });
    const merged = inputs.find(
      (i) =>
        i.getAttribute('aria-label') === 'Archive merged spaces automatically',
    )!;
    await click(merged);
    await settle();
    expect(lastTx()).toMatchObject({
      id: 'user:spaces.auto_archive_merged',
      data: { value: false },
    });
  });

  it('hides everything but the switch when spaces are off', async () => {
    store.sync.pool.put('setting', 'user:labs.build_mode', {
      key: 'labs.build_mode',
      scope: 'user',
      value: false,
    });
    await render();
    expect(labels()).toEqual([]);
    expect(m!.host.querySelector('.config-section')).toBeNull();
  });
});
