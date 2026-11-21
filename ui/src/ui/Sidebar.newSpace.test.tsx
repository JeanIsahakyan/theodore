/** The "+" beside the Spaces title opens New space; a "New space" row
 *  shows only while there are no spaces. */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setTransport } from '../core/transport';
import { RootStore } from '../stores/RootStore';
import { RootStoreProvider } from '../stores/context';
import { FakeTransport } from '../test/fakeTransport';
import { mount, settle, type Mounted } from '../test/dom';
import type { Space } from '../gen/contract';
import { Sidebar } from './Sidebar';

const space = (id: string): Space => ({
  id,
  project: 'local:app',
  name: id,
  goal: '',
  branch: `theo/${id}`,
  base: 'main',
  base_sha: 'b',
  head_sha: 'h',
  worktree: `/tmp/${id}`,
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
});

describe('sidebar Spaces "+"', () => {
  let store: RootStore;
  let view: Mounted;

  beforeEach(async () => {
    localStorage.clear();
    setTransport(new FakeTransport());
    store = new RootStore();
    view = await mount(
      <RootStoreProvider store={store}>
        <Sidebar />
      </RootStoreProvider>,
    );
  });

  afterEach(() => view.unmount());

  const plus = () =>
    [
      ...view.host.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="New space"]',
      ),
    ].filter((b) => !b.closest('[role=option]'));

  const rows = () =>
    [...view.host.querySelectorAll<HTMLElement>('[role=option]')].map(
      (r) => r.textContent,
    );

  it('shows the New space row only while there are no spaces', async () => {
    expect(rows()).toContain('New space');
    await act(async () => {
      store.sync.pool.put('space', 'a', space('a'));
    });
    await settle();
    expect(rows()).not.toContain('New space');
    expect(plus()).toHaveLength(1);
  });

  it('sits in the Spaces header and opens New space', async () => {
    expect(plus()).toHaveLength(1);
    expect(plus()[0]!.closest('header')!.textContent).toContain('Spaces');
    await act(async () => {
      plus()[0]!.click();
    });
    await settle();
    expect(store.ui.modal).toBe('new-space');
  });
});
