/** A space that runs on another device (docs/fleet.md "One space UI") is a
 *  row of the same Spaces list, with "on <host>" beside its name; there is
 *  no list of its own. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Space } from '../gen/contract';
import { setTransport } from '../core/transport';
import { RootStore } from '../stores/RootStore';
import { RootStoreProvider } from '../stores/context';
import { FakeTransport } from '../test/fakeTransport';
import { mount, type Mounted } from '../test/dom';
import { remoteSpace, status } from '../test/fleet';
import { Sidebar, deviceBadge, spaceContextMenu } from './Sidebar';

const space = (over: Partial<Space> & { id: string }): Space => ({
  project: 'local:app',
  name: over.id,
  goal: '',
  branch: `theo/${over.id}`,
  base: 'main',
  base_sha: 'b',
  head_sha: 'h',
  worktree: `/tmp/${over.id}`,
  status: 'idle',
  agent: 'claude',
  model: null,
  mode: 'edit',
  review_pr: null,
  pr: null,
  turns: 0,
  run: null,
  error: null,
  created_at: 0,
  updated_at: 0,
  ...over,
});

const REMOTE = {
  space: 'rs_1',
  host_device: 'd2',
  host_name: 'Studio Mac',
  project_name: 'api',
  started_here: true,
};

describe('a remote space in the sidebar', () => {
  let store: RootStore;
  let view: Mounted;

  beforeEach(async () => {
    localStorage.clear();
    setTransport(new FakeTransport());
    store = new RootStore();
    store.fleet.setStatus(status());
    store.fleet.upsertSpace(remoteSpace());
    store.sync.pool.put('space', 'a', space({ id: 'a', updated_at: 2 }));
    store.sync.pool.put(
      'space',
      'rs_1',
      space({
        id: 'rs_1',
        project: 'github:acme/api',
        worktree: '',
        updated_at: 1,
        remote: REMOTE,
      }),
    );
    view = await mount(
      <RootStoreProvider store={store}>
        <Sidebar />
      </RootStoreProvider>,
    );
  });

  afterEach(() => view.unmount());

  const rows = () => [
    ...view.host.querySelectorAll<HTMLElement>('[role=option]'),
  ];

  it('is listed with the local ones, its device beside its name', () => {
    const labels = rows().map((r) => r.textContent);
    expect(labels).toEqual(expect.arrayContaining(['a', 'rs_1on Studio Mac']));
    const badge = view.host.querySelector<HTMLElement>('.space-device')!;
    expect(badge.textContent).toBe('on Studio Mac');
    expect(badge.title).toBe('api · Studio Mac');
  });

  it('has no list of other devices', () => {
    expect(view.host.textContent).not.toContain('Other devices');
    expect(view.host.textContent).not.toContain('Run on another device');
  });

  it('opens on the ordinary space route', async () => {
    const row = rows().find((r) => r.textContent?.startsWith('rs_1'))!;
    row.click();
    expect(store.ui.route).toEqual({ name: 'space', id: 'rs_1' });
  });

  it("offers no Pin: the row is its host's", () => {
    const remote = store.models.spaces.get('rs_1')!;
    const ids = spaceContextMenu(remote, store.ui).map((i) => i.id);
    expect(ids).not.toContain('pin');
    expect(ids).toContain('archive');
    const local = store.models.spaces.get('a')!;
    expect(spaceContextMenu(local, store.ui).map((i) => i.id)).toContain('pin');
  });

  it('badges only a remote space', () => {
    expect(deviceBadge({ remote: null })).toBeUndefined();
    expect(deviceBadge({ remote: REMOTE })?.label).toBe('on Studio Mac');
  });
});
