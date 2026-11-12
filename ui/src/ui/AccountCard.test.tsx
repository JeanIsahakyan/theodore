/** The organization parts of the account UI: the sign-in's picker and
 *  Settings → Account's organization row and switcher. */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, mount, settle, type Mounted } from '../test/dom';
import { setTransport } from '../core/transport';
import { initialFlow, type AccountFlow } from '../core/accountFlow';
import type { AccountSignIn } from '../core/accountSignIn';
import type { AccountOrganization, AccountStatus } from '../gen/contract';
import { RootStore } from '../stores/RootStore';
import { RootStoreProvider } from '../stores/context';
import { FakeTransport } from '../test/fakeTransport';
import { AccountCard, SignInView } from './AccountCard';

// jsdom has no `CSS.escape`; an open react-aria popover calls it.
(globalThis as { CSS?: { escape?: (s: string) => string } }).CSS ??= {};
globalThis.CSS.escape ??= (s: string) =>
  s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);

let m: Mounted | null = null;

afterEach(() => {
  m?.unmount();
  m = null;
});

const buttons = (host: ParentNode) => [...host.querySelectorAll('button')];
const button = (host: ParentNode, label: string) =>
  buttons(host).find((b) => b.textContent?.trim() === label);

describe('sign-in organization picker', () => {
  const orgs = [
    { id: 'org_a', name: 'Acme' },
    { id: 'org_b', name: 'Ada Lovelace' },
  ];

  function signIn(over: Partial<AccountFlow> = {}): AccountSignIn {
    return {
      flow: {
        ...initialFlow,
        phase: 'choose_organization',
        organizations: orgs,
        ...over,
      },
      start: vi.fn(),
      cancel: vi.fn(),
      chooseOrganization: vi.fn(),
      reopen: vi.fn(),
    };
  }

  it('lists the organizations by name under a title', async () => {
    m = await mount(<SignInView signIn={signIn()} user={null} />);
    expect(m.host.textContent).toContain('Choose an organization');
    expect(button(m.host, 'Acme')).toBeTruthy();
    expect(button(m.host, 'Ada Lovelace')).toBeTruthy();
    expect(button(m.host, 'Cancel')).toBeTruthy();
  });

  it('picking one sends its id', async () => {
    const s = signIn();
    m = await mount(<SignInView signIn={s} user={null} />);
    await click(button(m.host, 'Ada Lovelace'));
    expect(s.chooseOrganization).toHaveBeenCalledWith('org_b');
  });

  it('disables the list while the pick is running, not Cancel', async () => {
    const s = signIn({ choosing: true });
    m = await mount(<SignInView signIn={s} user={null} />);
    expect(button(m.host, 'Acme')?.disabled).toBe(true);
    expect(button(m.host, 'Ada Lovelace')?.disabled).toBe(true);
    expect(m.host.textContent).toContain('Signing you in');
    await click(button(m.host, 'Acme'));
    expect(s.chooseOrganization).not.toHaveBeenCalled();
    await click(button(m.host, 'Cancel'));
    expect(s.cancel).toHaveBeenCalled();
  });
});

describe('Settings → Account organization', () => {
  const ada = {
    id: 'user_01',
    email: 'ada@example.com',
    name: 'Ada Lovelace',
    avatar_url: null,
  };
  const status = (
    organization: AccountStatus['organization'],
  ): AccountStatus => ({
    available: true,
    required: true,
    session_ended: false,
    user: ada,
    organization,
  });
  const personal: AccountOrganization = {
    id: 'org_me',
    name: "Ada's workspace",
    role: 'admin',
    personal: true,
  };
  const acme: AccountOrganization = {
    id: 'org_acme',
    name: 'Acme',
    role: 'member',
    personal: false,
  };

  let transport: FakeTransport;
  let store: RootStore;

  beforeEach(() => {
    transport = new FakeTransport();
    setTransport(transport);
    store = new RootStore();
  });

  async function render(s: AccountStatus) {
    store.ephemeral.setAccount(s);
    transport.onCall('account_status', () => s);
    m = await mount(
      <RootStoreProvider store={store}>
        <AccountCard />
      </RootStoreProvider>,
    );
    await settle();
  }

  const called = (cmd: string) => transport.calls.filter((c) => c.cmd === cmd);
  const trigger = () =>
    m!.host.querySelector<HTMLElement>('.account-organization-switch button');
  const option = (name: string) =>
    [...document.querySelectorAll('[role="option"]')].find((el) =>
      el.textContent?.trim().startsWith(name),
    ) as HTMLElement | undefined;
  const row = () => m!.host.querySelector('.account-organization');

  it('shows the organization name and the role', async () => {
    transport.onCall('account_organizations', () => [personal, acme]);
    await render(status({ id: 'org_acme', role: 'member' }));
    expect(row()?.textContent).toContain('Acme');
    expect(row()?.textContent).toContain('Member');
  });

  it('calls the personal organization Personal', async () => {
    transport.onCall('account_organizations', () => [personal]);
    await render(status({ id: 'org_me', role: 'admin' }));
    expect(row()?.textContent).toContain('Personal');
    expect(row()?.textContent).toContain('Admin');
    expect(row()?.textContent).not.toContain("Ada's workspace");
  });

  it('has no switcher with one organization', async () => {
    transport.onCall('account_organizations', () => [personal]);
    await render(status({ id: 'org_me', role: 'admin' }));
    expect(m!.host.querySelector('.account-organization-switch')).toBeNull();
  });

  it('has a switcher with two or more', async () => {
    transport.onCall('account_organizations', () => [personal, acme]);
    await render(status({ id: 'org_me', role: 'admin' }));
    expect(m!.host.querySelector('.account-organization-switch')).toBeTruthy();
  });

  it('shows nothing organization-related without one', async () => {
    transport.onCall('account_organizations', () => [personal, acme]);
    await render(status(null));
    expect(row()).toBeNull();
    expect(m!.host.querySelector('.account-organization-error')).toBeNull();
    expect(called('account_organizations')).toHaveLength(0);
    expect(m!.host.textContent).toContain('Ada Lovelace');
  });

  it('hides the switcher quietly when the list fails', async () => {
    transport.onCall('account_organizations', () => {
      throw Object.assign(new Error('x'), {
        code: 'account',
        message: 'account: network: timed out',
      });
    });
    await render(status({ id: 'org_acme', role: 'member' }));
    expect(m!.host.querySelector('.account-organization-switch')).toBeNull();
    expect(m!.host.querySelector('.account-organization-error')).toBeNull();
    expect(row()).toBeTruthy();
  });

  it('re-reads the list when the organization changes', async () => {
    transport.onCall('account_organizations', () => [personal, acme]);
    await render(status({ id: 'org_me', role: 'admin' }));
    expect(called('account_organizations')).toHaveLength(1);
    await act(async () =>
      store.ephemeral.setAccount(status({ id: 'org_acme', role: 'member' })),
    );
    await settle();
    expect(called('account_organizations')).toHaveLength(2);
    expect(row()?.textContent).toContain('Acme');
  });

  it('switching sends the id and shows the new organization', async () => {
    transport.onCall('account_organizations', () => [personal, acme]);
    transport.onCall('account_switch_organization', () =>
      status({ id: 'org_acme', role: 'member' }),
    );
    await render(status({ id: 'org_me', role: 'admin' }));
    await click(trigger());
    await settle();
    await click(option('Acme'));
    await settle();
    expect(called('account_switch_organization')[0]?.args).toEqual({
      organizationId: 'org_acme',
    });
    expect(store.ephemeral.account?.organization?.id).toBe('org_acme');
    expect(row()?.textContent).toContain('Acme');
  });

  it('a failed switch shows the error and keeps the old organization', async () => {
    transport.onCall('account_organizations', () => [personal, acme]);
    transport.onCall('account_switch_organization', () => {
      throw Object.assign(new Error('x'), {
        code: 'account',
        message: 'not a member of that organization',
      });
    });
    await render(status({ id: 'org_me', role: 'admin' }));
    await click(trigger());
    await settle();
    await click(option('Acme'));
    await settle();
    expect(
      m!.host.querySelector('.account-organization-error')?.textContent,
    ).toContain('not a member of that organization');
    expect(store.ephemeral.account?.organization?.id).toBe('org_me');
    expect(row()?.textContent).toContain('Personal');
    // Still signed in, the switcher still there.
    expect(store.ephemeral.account?.user).not.toBeNull();
    expect(m!.host.querySelector('.account-organization-switch')).toBeTruthy();
  });
});
