/** Project settings → Spaces: the project's config as it applies, and its
 *  own values for the space settings over the global ones. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EffectiveConfig, Project } from '../../gen/contract';
import { setTransport } from '../../core/transport';
import { projectSettingsRoute } from '../../core/workspaces';
import { RootStore } from '../../stores/RootStore';
import { RootStoreProvider } from '../../stores/context';
import { FakeTransport } from '../../test/fakeTransport';
import { click, mount, settle, typeInto, type Mounted } from '../../test/dom';
import { ProjectSpaces } from './ProjectSpaces';

const WEB: Project = {
  id: 'github:acme/web',
  repo: { host: 'github', owner: 'acme', name: 'web' },
  path: null,
  status: 'ready',
  error: null,
  default_branch: 'main',
  added_at: 1,
  description: null,
  private: false,
  pushed_at: null,
  last_fetched_at: null,
} as Project;

const CONFIG: EffectiveConfig = {
  files: [
    { layer: 'global', path: '/home/u/.theodore/config.yaml', exists: false },
    { layer: 'repo', path: '.theodore/config.yaml', exists: true },
  ],
  entries: [
    { key: 'spaces.check', value: 'pnpm test', layer: 'repo' },
    { key: 'spaces.ports', value: '2', layer: 'repo' },
  ],
  unknown: [],
  repo_commands: { hash: 'abc', trusted: false, items: [] },
} as unknown as EffectiveConfig;

let m: Mounted | null = null;
let transport: FakeTransport;
let store: RootStore;

beforeEach(() => {
  transport = new FakeTransport();
  transport.onCall('project_config', () => CONFIG);
  transport.onCall('transact', () => ({ status: 'ok', last_sync_id: 1 }));
  setTransport(transport);
  store = new RootStore();
  store.sync.pool.put('project', WEB.id, WEB);
});

afterEach(() => {
  m?.unmount();
  m = null;
});

const render = async () => {
  m = await mount(
    <RootStoreProvider store={store}>
      <ProjectSpaces project={WEB} />
    </RootStoreProvider>,
  );
  await settle();
};

const seed = (key: string, value: unknown, scope = 'user') =>
  store.sync.pool.put('setting', `${scope}:${key}`, { key, scope, value });

const rowOf = (key: string) =>
  m!.host.querySelector<HTMLElement>(`.override-${key.replace(/\./g, '-')}`)!;
const sourceOf = (key: string) =>
  rowOf(key).querySelector('.set-source')?.textContent;
const inputOf = (key: string) => rowOf(key).querySelector('input')!;
const resetOf = (key: string) =>
  rowOf(key).querySelector<HTMLButtonElement>('.set-reset');
const lastTx = () => {
  const c = [...transport.calls].reverse().find((c) => c.cmd === 'transact');
  return (c?.args as { tx: { ops: unknown[] } } | undefined)?.tx.ops[0];
};
const settingRow = (scope: string, key: string) =>
  store.models.settings.get(`${scope}:${key}`);

describe('Project settings → Spaces', () => {
  it('shows the project’s config as it applies, and a way to the editor', async () => {
    await render();
    expect(
      transport.calls.find((c) => c.cmd === 'project_config')?.args,
    ).toEqual({ project: WEB.id });
    const t = m!.host.textContent ?? '';
    expect(t).toContain('.theodore/config.yaml');
    expect(t).toContain('spaces.check');
    expect(t).toContain('not allowed yet');
    await click(m!.host.querySelector('.project-config-edit'));
    expect(store.ui.route).toEqual(projectSettingsRoute(WEB.id, 'config'));
  });

  it('each row says what is in effect and where it comes from', async () => {
    seed('spaces.max_children', 3);
    seed('spaces.max_depth', 1, 'project:github:acme/web');
    seed('spaces.ask_timeout_secs', 30, 'project:github:acme/other');
    await render();
    expect(sourceOf('spaces.auto_archive_days')).toBe('Default · 7 days');
    expect(sourceOf('spaces.max_children')).toBe('Global · 3');
    expect(sourceOf('spaces.max_depth')).toBe('This project');
    expect(inputOf('spaces.max_depth').value).toBe('1');
    // Another project's override is not this one's.
    expect(sourceOf('spaces.ask_timeout_secs')).toBe('Default · 180 s');
    // The field is empty with the inherited value as its placeholder.
    expect(inputOf('spaces.max_children').value).toBe('');
    expect(inputOf('spaces.max_children').placeholder).toBe('3');
    expect(resetOf('spaces.max_children')).toBeNull();
    expect(resetOf('spaces.max_depth')).not.toBeNull();
  });

  it('a typed value becomes the project’s own row; Reset clears it', async () => {
    seed('spaces.auto_archive_days', 3);
    await render();
    const key = 'spaces.auto_archive_days';
    await typeInto(inputOf(key), '10');
    inputOf(key).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await settle();
    expect(lastTx()).toMatchObject({
      op: 'create',
      model: 'setting',
      id: 'project:github:acme/web:spaces.auto_archive_days',
      data: { key, scope: 'project:github:acme/web', value: 10 },
    });
    expect(sourceOf(key)).toBe('This project');
    // The global row is untouched.
    expect(settingRow('user', key)?.value).toBe(3);

    await click(resetOf(key));
    await settle();
    expect(lastTx()).toMatchObject({
      op: 'update',
      id: 'project:github:acme/web:spaces.auto_archive_days',
      data: { value: null },
    });
    expect(sourceOf(key)).toBe('Global · 3 days');
    expect(resetOf(key)).toBeNull();
  });

  it('a value the setting does not accept is dropped', async () => {
    await render();
    const key = 'spaces.ask_timeout_secs';
    await typeInto(inputOf(key), '0');
    inputOf(key).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await settle();
    expect(transport.calls.some((c) => c.cmd === 'transact')).toBe(false);
    expect(inputOf(key).value).toBe('');
  });

  it('the switch writes the project’s own boolean', async () => {
    await render();
    const key = 'spaces.auto_archive_merged';
    expect(sourceOf(key)).toBe('Default · On');
    const sw = rowOf(key).querySelector<HTMLInputElement>('input')!;
    expect(sw.checked).toBe(true);
    await click(sw);
    await settle();
    expect(lastTx()).toMatchObject({
      op: 'create',
      id: 'project:github:acme/web:spaces.auto_archive_merged',
      data: { key, scope: 'project:github:acme/web', value: false },
    });
    expect(sourceOf(key)).toBe('This project');
    expect(resetOf(key)).not.toBeNull();
  });
});
