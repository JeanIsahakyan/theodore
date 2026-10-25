import { mount, type Mounted } from '../test/dom';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrSummary, RepoRef } from '../gen/contract';
import { RootStore } from '../stores/RootStore';
import { RootStoreProvider } from '../stores/context';
import { PrRow, RowList, pressOpens, type InboxPr } from './List';

const repo: RepoRef = { host: 'github', owner: 'acme', name: 'web' };
const ID = 'github:acme/web#1';

const summary = (over: Partial<PrSummary> = {}): PrSummary => ({
  pr: { repo, number: 1, host_id: null },
  title: 'a change',
  author: { login: 'me', name: null, avatar_url: null },
  state: 'open',
  base_ref: 'main',
  head_ref: 'feature',
  head_sha: 'abc',
  additions: 1,
  deletions: 1,
  changed_files: 1,
  reasons: ['review_requested'],
  checks: 'pass',
  approvals: 0,
  required_approvals: null,
  updated_at: 0,
  url: 'https://github.com/acme/web/pull/1',
  ...over,
});

type Mods = { shiftKey?: boolean; metaKey?: boolean; button?: number };

/** A real mouse click as a browser sends it: pointer down, up, click. */
async function mouseClick(el: Element | null, mods: Mods = {}) {
  if (!el) throw new Error('mouseClick: no element');
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    button: mods.button ?? 0,
    buttons: 1,
    detail: 1,
    shiftKey: !!mods.shiftKey,
    metaKey: !!mods.metaKey,
  };
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerdown', init));
    el.dispatchEvent(new MouseEvent('mousedown', init));
    el.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
  });
}

describe('pressOpens', () => {
  const plain = {
    pointerType: 'mouse',
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
  };
  it('opens on a plain mouse click only', () => {
    expect(pressOpens(plain)).toBe(true);
    expect(pressOpens({ ...plain, metaKey: true })).toBe(false);
    expect(pressOpens({ ...plain, shiftKey: true })).toBe(false);
    expect(pressOpens({ ...plain, ctrlKey: true })).toBe(false);
    expect(pressOpens({ ...plain, altKey: true })).toBe(false);
    // Enter, touch and virtual presses already go through `onAction`.
    expect(pressOpens({ ...plain, pointerType: 'keyboard' })).toBe(false);
    expect(pressOpens({ ...plain, pointerType: 'touch' })).toBe(false);
  });
});

describe('RowList click', () => {
  let m: Mounted | null = null;
  afterEach(() => {
    m?.unmount();
    m = null;
    document.body.innerHTML = '';
    localStorage.clear();
  });

  async function render(over: Partial<PrSummary> = {}) {
    const store = new RootStore();
    act(() => store.sync.pool.put('pr', ID, summary(over)));
    const onOpen = vi.fn((id: string) =>
      store.ui.go({ name: 'review', pr: id }),
    );
    const onSelect = vi.fn((id: string) => store.ui.select(id));
    const items = [store.models.prSummaries.get(ID)!] as InboxPr[];
    m = await mount(
      <RootStoreProvider store={store}>
        <RowList
          groups={[{ id: 'review', title: 'Review', items }]}
          sel={null}
          closed={{}}
          toggle={() => {}}
          onSelect={onSelect}
          onOpen={onOpen}
          row={(id) => <PrRow id={id} sel={false} picked={false} />}
        />
      </RootStoreProvider>,
    );
    const row = document.getElementById(`R-${ID}`);
    return { store, onOpen, onSelect, row };
  }

  it('opens the PR on a single click', async () => {
    const { store, onOpen, row } = await render();
    await mouseClick(row!.querySelector('.font-medium'));
    expect(onOpen).toHaveBeenCalledWith(ID);
    expect(store.ui.route).toEqual({ name: 'review', pr: ID });
  });

  it('only selects on ⌘- or Shift-click', async () => {
    const { onOpen, onSelect, row } = await render();
    await mouseClick(row, { metaKey: true });
    await mouseClick(row, { shiftKey: true });
    expect(onOpen).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith(ID);
  });

  it('never opens on a right click', async () => {
    const { onOpen, row } = await render();
    await mouseClick(row, { button: 2 });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('picks the row from its checkbox without opening it', async () => {
    const { store, onOpen, row } = await render();
    // The press lands on the box (the label) and its input takes the click.
    await mouseClick(row!.querySelector('.pickbox'));
    await mouseClick(row!.querySelector('.pickbox input'));
    expect(onOpen).not.toHaveBeenCalled();
    expect(store.ui.picked).toEqual([ID]);
    expect(store.ui.route.name).not.toBe('review');
  });

  it('a stack chip opens its own PR, not the row', async () => {
    const { store, onOpen, row } = await render({
      stack: { base_pr: 9, children: [] },
    });
    await mouseClick(row!.querySelector('.stack-chip'));
    expect(onOpen).not.toHaveBeenCalled();
    expect(store.ui.route).toEqual({
      name: 'review',
      pr: 'github:acme/web#9',
    });
  });
});
