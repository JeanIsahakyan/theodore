/** A sub-space sits under the space whose agent started it, one step in,
 *  and collapses with it; one whose parent isn't listed stays at the top
 *  with "from <parent>". The Agents entry leads the Spaces section. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Space } from '../gen/contract';
import { setTransport } from '../core/transport';
import { RootStore } from '../stores/RootStore';
import { RootStoreProvider } from '../stores/context';
import { FakeTransport } from '../test/fakeTransport';
import { click, mount, type Mounted } from '../test/dom';
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

describe('sub-spaces in the sidebar', () => {
  let store: RootStore;
  let view: Mounted;

  beforeEach(async () => {
    localStorage.clear();
    for (const id of [...collapsedSpaces]) toggleSubSpaces(id);
    setTransport(new FakeTransport());
    store = new RootStore();
    const put = (s: Space) => store.sync.pool.put('space', s.id, s);
    put(space({ id: 'top', updated_at: 9 }));
    put(space({ id: 'parent', updated_at: 5 }));
    put(
      space({
        id: 'kid',
        updated_at: 7,
        status: 'running',
        parent: { space: 'parent', depth: 1 },
      }),
    );
    put(
      space({
        id: 'grandkid',
        updated_at: 1,
        parent: { space: 'kid', depth: 2 },
      }),
    );
    put(space({ id: 'old', status: 'archived', title: 'Old work' }));
    put(space({ id: 'orphan', parent: { space: 'old', depth: 1 } }));
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
  const spaceRows = () =>
    rows()
      .filter((r) => r.querySelector('[aria-label="Archive space"]'))
      .map((r) => `${'>'.repeat(Number(r.dataset.depth ?? 0))}${label(r)}`);

  it('nests each child under its parent, not at the top', () => {
    expect(spaceRows()).toEqual([
      'top',
      'parent',
      '>kid',
      '>>grandkid',
      'orphan',
    ]);
  });

  it('names the parent of a child shown on its own', () => {
    const orphan = rows().find((r) => label(r) === 'orphan')!;
    expect(orphan.querySelector('.space-from')?.textContent).toBe(
      'from Old work',
    );
  });

  it('collapses, still saying how many and that one runs', async () => {
    const parent = rows().find((r) => label(r) === 'parent')!;
    expect(
      parent.querySelector('.space-subs')?.getAttribute('aria-label'),
    ).toBe('2 sub-spaces, 1 running');
    const spinner = '.space-subs > span.inline-flex';
    // Shown open, the running one speaks for itself.
    expect(parent.querySelector(spinner)).toBeNull();
    await click(parent.querySelector('[aria-label="Hide sub-spaces"]'));
    expect(spaceRows()).toEqual(['top', 'parent', 'orphan']);
    const shut = rows().find((r) => label(r) === 'parent')!;
    // A spinner says one of the hidden ones runs.
    expect(shut.querySelector(spinner)).not.toBeNull();
    await click(shut.querySelector('[aria-label="Show sub-spaces"]'));
    expect(spaceRows()).toContain('>kid');
  });

  it('leads with Agents, counting the spaces running a turn', () => {
    const agents = rows().find((r) => label(r) === 'Agents')!;
    expect(agents.textContent).toBe('Agents1');
    agents.click();
    expect(store.ui.route).toEqual({ name: 'agents' });
  });
});
