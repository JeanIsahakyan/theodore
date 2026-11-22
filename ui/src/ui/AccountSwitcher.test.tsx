/** The sidebar's bottom row and its popover (docs/cloud.md "Several
 *  accounts"): the active account and its organization on the row; every
 *  account with its organizations in the popover, the current one checked,
 *  "N running" on the others; Add another account, Settings…, Sign out of
 *  the active one; "Sign in again" for an ended session. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { click, mount, settle, type Mounted } from '../test/dom';
import { setTransport } from '../core/transport';
import type { AccountEntry, AccountStatus, Space } from '../gen/contract';
import { RootStore } from '../stores/RootStore';
import { RootStoreProvider } from '../stores/context';
import { FakeTransport } from '../test/fakeTransport';
import { AccountSwitcher } from './AccountSwitcher';

// jsdom has no `CSS.escape`; an open react-aria popover calls it.
(globalThis as { CSS?: { escape?: (s: string) => string } }).CSS ??= {};
globalThis.CSS.escape ??= (s: string) =>
  s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);

const jean: AccountEntry = {
  user: {
    id: 'user_01',
    email: 'jean@example.com',
    name: 'Jean Isahakyan',
    avatar_url: null,
  },
  organization: { id: 'org_me', role: 'admin' },
  organizations: [
    { id: 'org_me', name: "Jean's workspace", role: 'admin', personal: true },
    { id: 'org_studio', name: 'Acme Studio', role: 'member', personal: false },
  ],
  active: true,
  sign_in_required: false,
};
const work: AccountEntry = {
  user: { id: 'user_02', email: 'jean@acme.com', name: null, avatar_url: null },
  organization: { id: 'org_acme', role: 'member' },
  organizations: [
    { id: 'org_acme', name: 'Acme Inc', role: 'member', personal: false },
  ],
  active: false,
  sign_in_required: false,
};

const status = (accounts: AccountEntry[]): AccountStatus => {
  const active = accounts.find((a) => a.active) ?? null;
  return {
    available: true,
    required: true,
    session_ended: false,
    user: active?.user ?? null,
    organization: active?.organization ?? null,
    accounts,
  };
};

const space = (id: string, account: string | null, running = true): Space =>
  ({
    id,
    project: 'local:app',
    name: id,
    goal: '',
    branch: id,
    base: 'main',
    base_sha: 'b',
    head_sha: 'h',
    worktree: `/tmp/${id}`,
    status: running ? 'running' : 'idle',
    agent: 'claude',
    model: null,
    mode: 'edit',
    review_pr: null,
    pr: null,
    turns: 0,
    run: null,
    error: null,
    account,
    created_at: 0,
    updated_at: 0,
  }) as Space;

let m: Mounted | null = null;
let transport: FakeTransport;
let store: RootStore;

beforeEach(() => {
  transport = new FakeTransport();
  setTransport(transport);
  store = new RootStore();
});

afterEach(() => {
  m?.unmount();
  m = null;
});

async function render(s: AccountStatus) {
  store.ephemeral.setAccount(s);
  transport.onCall('account_accounts', () => store.ephemeral.account);
  m = await mount(
    <RootStoreProvider store={store}>
      <AccountSwitcher />
    </RootStoreProvider>,
  );
  await settle();
}

const trigger = () => m!.host.querySelector<HTMLElement>('.account-menu');
const menu = () => document.querySelector('[role="menu"]');
const items = () => [
  ...document.querySelectorAll<HTMLElement>(
    '[role="menuitemradio"], [role="menuitem"]',
  ),
];
const item = (text: string) =>
  items().find((el) => el.textContent?.trim().startsWith(text));
const called = (cmd: string) => transport.calls.filter((c) => c.cmd === cmd);

async function open() {
  await click(trigger());
  await settle();
}

describe('the sidebar account row', () => {
  it('names the active account and its organization', async () => {
    await render(status([jean, work]));
    expect(trigger()?.textContent).toContain('Jean · Personal');
  });

  it('shows the name alone until the organizations are listed', async () => {
    await render(status([{ ...jean, organizations: [] }]));
    // The avatar's fallback letter comes first in the text.
    expect(trigger()?.textContent?.trim()).toBe('JJean');
    expect(trigger()?.textContent).not.toContain('·');
  });

  it('falls back to the host login without a Theodore account', async () => {
    store.ephemeral.setViewer({
      login: 'octocat',
      name: null,
      avatar_url: null,
    });
    await render({ ...status([]), available: false, required: false });
    expect(trigger()?.textContent).toContain('octocat');
  });
});

describe('the popover', () => {
  it('lists every account with its organizations, the current one checked', async () => {
    await render(status([jean, work]));
    await open();
    expect(menu()).toBeTruthy();
    const text = menu()!.textContent ?? '';
    expect(text).toContain('Jean Isahakyan');
    expect(text).toContain('jean@acme.com');
    expect(item('Personal')).toBeTruthy();
    expect(item('Acme Studio')).toBeTruthy();
    expect(item('Acme Inc')).toBeTruthy();
    expect(item('Personal')?.getAttribute('aria-checked')).toBe('true');
    expect(item('Acme Studio')?.getAttribute('aria-checked')).toBe('false');
    expect(item('Add another account')).toBeTruthy();
    expect(item('Settings…')).toBeTruthy();
    expect(item('Sign out of Jean')).toBeTruthy();
    // Opening lists the organizations again.
    expect(called('account_accounts')).toHaveLength(1);
  });

  it('says how many spaces run for another account', async () => {
    store.sync.pool.put('space', 'a', space('a', 'user_02'));
    store.sync.pool.put('space', 'b', space('b', 'user_02'));
    store.sync.pool.put('space', 'c', space('c', 'user_02', false));
    store.sync.pool.put('space', 'd', space('d', 'user_01'));
    await render(status([jean, work]));
    await open();
    const running = [...document.querySelectorAll('.account-running')].map(
      (el) => el.textContent?.trim(),
    );
    expect(running).toEqual(['· 2 running']);
  });

  it("switches to another account's organization", async () => {
    await render(status([jean, work]));
    transport.onCall('account_switch', () =>
      status([
        { ...jean, active: false },
        { ...work, active: true },
      ]),
    );
    await open();
    await click(item('Acme Inc'));
    await settle();
    expect(called('account_switch')[0]?.args).toEqual({
      req: { user_id: 'user_02', organization_id: 'org_acme' },
    });
    expect(store.ephemeral.account?.user?.id).toBe('user_02');
    expect(trigger()?.textContent).toContain('jean@acme.com · Acme Inc');
  });

  it('switches the active account to another of its organizations', async () => {
    await render(status([jean, work]));
    transport.onCall('account_switch', () =>
      status([
        { ...jean, organization: { id: 'org_studio', role: 'member' } },
        work,
      ]),
    );
    await open();
    await click(item('Acme Studio'));
    await settle();
    expect(called('account_switch')[0]?.args).toEqual({
      req: { user_id: 'user_01', organization_id: 'org_studio' },
    });
    expect(trigger()?.textContent).toContain('Jean · Acme Studio');
  });

  it('does nothing on the current organization', async () => {
    await render(status([jean, work]));
    await open();
    await click(item('Personal'));
    await settle();
    expect(called('account_switch')).toHaveLength(0);
  });

  it('signs out of the active account only', async () => {
    await render(status([jean, work]));
    transport.onCall('account_sign_out_of', () =>
      status([{ ...work, active: true }]),
    );
    await open();
    await click(item('Sign out of Jean'));
    await settle();
    expect(called('account_sign_out_of')[0]?.args).toEqual({
      userId: 'user_01',
    });
    expect(store.ephemeral.account?.accounts.map((a) => a.user.id)).toEqual([
      'user_02',
    ]);
  });

  it('opens the sign-in dialog to add an account', async () => {
    await render(status([jean]));
    await open();
    await click(item('Add another account'));
    expect(store.ui.modal).toBe('sign-in');
    expect(store.ui.modalTargets).toEqual([]);
  });

  it('offers "Sign in again" with the email for an ended session', async () => {
    await render(status([jean, { ...work, sign_in_required: true }]));
    await open();
    expect(item('Acme Inc')).toBeUndefined();
    await click(item('Sign in again'));
    expect(store.ui.modal).toBe('sign-in');
    expect(store.ui.modalTargets).toEqual(['jean@acme.com']);
  });

  it('goes to Settings → Account', async () => {
    await render(status([jean]));
    await open();
    await click(item('Settings…'));
    expect(store.ui.route).toEqual({ name: 'settings', page: 'account' });
  });

  it('keeps Settings and Report a problem without an account', async () => {
    await render({ ...status([]), available: false, required: false });
    await open();
    expect(item('Settings…')).toBeTruthy();
    expect(item('Report a problem…')).toBeTruthy();
    expect(item('Sign in')).toBeUndefined();
    expect(items().some((i) => i.textContent?.includes('Sign out'))).toBe(
      false,
    );
    expect(called('account_accounts')).toHaveLength(0);
  });
});
