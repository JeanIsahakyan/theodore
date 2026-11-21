/** The "+" beside the Spaces title opens New space, like the row that ends
 *  the list. */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setTransport } from '../core/transport';
import { RootStore } from '../stores/RootStore';
import { RootStoreProvider } from '../stores/context';
import { FakeTransport } from '../test/fakeTransport';
import { mount, settle, type Mounted } from '../test/dom';
import { Sidebar } from './Sidebar';

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
