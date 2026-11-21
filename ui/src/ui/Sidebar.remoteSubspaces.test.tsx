/** A space mirrored from another computer nests the sub-spaces it started
 *  there (`remote_sub_space` rows) like local ones: grandchildren under
 *  their parent, a stage mark, collapse with it, gone when the row goes.
 *  None of them is a space here: no archive, no page of its own. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RemoteSubSpace, Space } from '../gen/contract';
import { setTransport } from '../core/transport';
import { RootStore } from '../stores/RootStore';
import { RootStoreProvider } from '../stores/context';
import { FakeTransport } from '../test/fakeTransport';
import { click, mount, settle, type Mounted } from '../test/dom';
import { collapsedSpaces, toggleSubSpaces } from './space/collapsed';
import { Sidebar } from './Sidebar';

const space = (over: Partial<Space> & { id: string }): Space => ({
  project: 'local:app',
  name: over.id,
  goal: '',
  branch: `theo/${over.id}`,
  base: 'main',
  base_sha: 'b',
  head_sha: 'h',
  worktree: '',
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
  project_name: 'app',
  started_here: true,
};

const sub = (
  id: string,
  parent: string,
  over: Partial<RemoteSubSpace> = {},
): RemoteSubSpace => ({
  root: 'rs_1',
  space: id,
  parent,
  title: id,
  status: 'idle',
  mode: 'edit',
  done: false,
  seq: 1,
  ...over,
});

describe("a mirrored space's sub-spaces in the sidebar", () => {
  let store: RootStore;
  let view: Mounted;
  const putSub = (s: RemoteSubSpace) =>
    store.sync.pool.put('remote_sub_space', `${s.root}:${s.space}`, s);

  beforeEach(async () => {
    localStorage.clear();
    for (const id of [...collapsedSpaces]) toggleSubSpaces(id);
    setTransport(new FakeTransport());
    store = new RootStore();
    store.sync.pool.put('space', 'a', space({ id: 'a', updated_at: 2 }));
    store.sync.pool.put(
      'space',
      'rs_1',
      space({ id: 'rs_1', title: 'Port it', updated_at: 1, remote: REMOTE }),
    );
    putSub(sub('c1', 'rs_1', { title: 'Parser', status: 'running', seq: 2 }));
    putSub(sub('c2', 'c1', { title: 'Its tests', status: 'question', seq: 3 }));
    putSub(sub('c3', 'rs_1', { title: 'Docs', done: true, seq: 4 }));
    // Archived on the host: not shown.
    putSub(sub('c4', 'rs_1', { title: 'Old', status: 'archived', seq: 5 }));
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
  const label = (r: HTMLElement) =>
    r.querySelector('.truncate')?.textContent ?? '';
  const tree = () =>
    rows()
      .filter(
        (r) =>
          r.dataset.remoteSub ||
          r.querySelector('[aria-label="Archive space"]'),
      )
      .map(
        (r) =>
          `${'>'.repeat(Number(r.dataset.depth ?? 0))}${r.dataset.remoteSub ? '~' : ''}${label(r)}`,
      );
  const row = (name: string) => rows().find((r) => label(r) === name)!;

  it('nests them under the mirrored space, grandchildren under their parent', () => {
    expect(tree()).toEqual([
      'a',
      'Port it',
      '>~Parser',
      '>>~Its tests',
      '>~Docs',
    ]);
    expect(
      row('Port it').querySelector('.space-subs')?.getAttribute('aria-label'),
    ).toBe('3 sub-spaces, 2 running, 1 waiting for you');
  });

  it('marks each with its stage and says where it runs', () => {
    expect(
      row('Docs').querySelector('[aria-label="Merged into its parent"]'),
    ).not.toBeNull();
    expect(row('Docs').querySelector('.truncate')!.className).toContain(
      'text-muted',
    );
    expect(
      row('Its tests').querySelector('[aria-label="Waiting for an answer"]'),
    ).not.toBeNull();
    expect(
      row('Its tests').querySelector<HTMLElement>('.truncate')!.title,
    ).toBe(
      'Its tests · waiting for you · runs on Studio Mac as a sub-space of Parser',
    );
    expect(row('Parser').querySelector<HTMLElement>('.truncate')!.title).toBe(
      'Parser · running · runs on Studio Mac as a sub-space of Port it',
    );
  });

  it('is never a space here: no archive, pressing one opens the mirrored space', () => {
    for (const name of ['Parser', 'Its tests', 'Docs']) {
      expect(
        row(name).querySelector('[aria-label="Archive space"]'),
      ).toBeNull();
    }
    row('Its tests').click();
    expect(store.ui.route).toEqual({ name: 'space', id: 'rs_1' });
  });

  it('collapses with its parent, and under its own', async () => {
    await click(row('Parser').querySelector('[aria-label="Hide sub-spaces"]'));
    expect(tree()).toEqual(['a', 'Port it', '>~Parser', '>~Docs']);
    await click(row('Port it').querySelector('[aria-label="Hide sub-spaces"]'));
    expect(tree()).toEqual(['a', 'Port it']);
  });

  it('follows the rows: an update moves it, a removal drops it', async () => {
    putSub(sub('c2', 'rs_1', { title: 'Its tests', status: 'idle', seq: 6 }));
    store.sync.pool.remove('remote_sub_space', 'rs_1:c1');
    await settle();
    expect(tree()).toEqual(['a', 'Port it', '>~Its tests', '>~Docs']);
  });
});
