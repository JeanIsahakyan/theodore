import { beforeEach, describe, expect, it } from 'vitest';
import { setTransport } from '../../core/transport';
import type { RootStore } from '../../stores/RootStore';
import { UiStore } from '../../stores/UiStore';
import { FakeTransport } from '../../test/fakeTransport';
import { branchReviewMenu, closeBranchReview } from './closeReview';

const PR = 'local:local/web#123';

let transport: FakeTransport;
let store: RootStore;

beforeEach(() => {
  localStorage.clear();
  transport = new FakeTransport();
  setTransport(transport);
  store = { ui: new UiStore() } as unknown as RootStore;
});

describe('closeBranchReview', () => {
  it('closes the review on the core and drops its open tab', async () => {
    transport.onCall('close_branch_review', () => null);
    store.ui.go({ name: 'review', pr: PR });

    expect(await closeBranchReview(store, PR)).toBe(true);

    expect(transport.calls).toContainEqual({
      cmd: 'close_branch_review',
      args: { pr: PR },
    });
    expect(store.ui.tabs.some((t) => t.name === 'review')).toBe(false);
    expect(store.ui.route).toEqual({ name: 'inbox' });
  });

  it('keeps the tab when the core rejects the close', async () => {
    transport.queueResult(
      'close_branch_review',
      Object.assign(new Error('host PR'), {
        code: 'invalid',
        message: 'host PR',
      }),
    );
    store.ui.go({ name: 'review', pr: PR });

    expect(await closeBranchReview(store, PR)).toBe(false);
    expect(store.ui.route).toEqual({ name: 'review', pr: PR });
  });
});

describe('branchReviewMenu', () => {
  it('offers Open, Open in new tab and a destructive Close review', () => {
    const menu = branchReviewMenu(store, PR);
    expect(menu.map((m) => m.id)).toEqual([
      'open',
      'open-new-tab',
      'close-review',
    ]);
    expect(menu.at(-1)).toMatchObject({ label: 'Close review', danger: true });
  });
});
