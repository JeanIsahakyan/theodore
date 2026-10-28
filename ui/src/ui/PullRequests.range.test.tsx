import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PrId, PrSummary } from '../gen/contract';
import { NO_ACCOUNT } from '../core/accountGate';
import { setTransport } from '../core/transport';
import { RootStore } from '../stores/RootStore';
import { RootStoreProvider } from '../stores/context';
import { FakeTransport } from '../test/fakeTransport';
import { click, mount, type Mounted } from '../test/dom';
import { PullRequests } from './PullRequests';

const id = (number: number) => `github:acme/web#${number}` as PrId;
const summary = (number: number): PrSummary => ({
  pr: {
    repo: { host: 'github', owner: 'acme', name: 'web' },
    number,
    host_id: null,
  },
  title: `Pull request ${number}`,
  author: { login: 'ada', name: 'Ada', avatar_url: null },
  state: 'open',
  base_ref: 'main',
  head_ref: 'feature',
  head_sha: 'a'.repeat(40),
  additions: 1,
  deletions: 0,
  changed_files: 1,
  reasons: ['review_requested'],
  checks: 'none',
  approvals: 0,
  required_approvals: null,
  updated_at: number,
  url: `https://github.com/acme/web/pull/${number}`,
});

let store: RootStore;
let view: Mounted | null = null;

beforeEach(() => {
  localStorage.clear();
  HTMLElement.prototype.scrollIntoView ??= () => {};
  setTransport(new FakeTransport());
  store = new RootStore();
  store.ephemeral.setAccount(NO_ACCOUNT);
  store.ephemeral.setViewer({ login: 'ada', name: 'Ada', avatar_url: null });
  store.sync.pool.put('pr', id(1), summary(1));
  store.sync.pool.put('pr', id(2), summary(2));
});

afterEach(() => {
  view?.unmount();
  view = null;
});

describe('PullRequests checkbox selection', () => {
  it('renders owner changes for range selection and clearing', async () => {
    view = await mount(
      <RootStoreProvider store={store}>
        <PullRequests />
      </RootStoreProvider>,
    );

    const checkboxes = () => [
      ...view!.host.querySelectorAll<HTMLInputElement>(
        '.pickbox input[type="checkbox"]',
      ),
    ];
    expect(checkboxes().map((checkbox) => checkbox.checked)).toEqual([
      false,
      false,
    ]);

    await click(checkboxes()[0]);
    await act(async () => {
      checkboxes()[1]!.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          detail: 1,
          shiftKey: true,
        }),
      );
    });

    expect(new Set(store.ui.picked)).toEqual(new Set([id(1), id(2)]));
    expect(checkboxes().map((checkbox) => checkbox.checked)).toEqual([
      true,
      true,
    ]);

    await act(async () => {
      checkboxes()[1]!.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          detail: 1,
          shiftKey: true,
        }),
      );
    });

    expect(store.ui.picked).toEqual([]);
    expect(checkboxes().map((checkbox) => checkbox.checked)).toEqual([
      false,
      false,
    ]);
  });
});
