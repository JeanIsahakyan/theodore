/** The organization parts of the account UI: the sign-in's picker and
 *  Settings → Account's organization row and switcher. */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, mount, settle, typeInto, type Mounted } from '../test/dom';
import { setTransport } from '../core/transport';
import { initialFlow, type AccountFlow } from '../core/accountFlow';
import type { AccountSignIn } from '../core/accountSignIn';
import type {
  AccountEntry,
  AccountOrganization,
  AccountStatus,
} from '../gen/contract';
import { RootStore } from '../stores/RootStore';
import { RootStoreProvider } from '../stores/context';
import { FakeTransport } from '../test/fakeTransport';
import {
  AccountCard,
  deleteErrorText,
  SignInView,
  switchErrorText,
} from './AccountCard';

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
    accounts: [],
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
        message:
          'account: rejected: organization_membership_not_found: User is not a member of the organization.',
      });
    });
    await render(status({ id: 'org_me', role: 'admin' }));
    await click(trigger());
    await settle();
    await click(option('Acme'));
    await settle();
    expect(
      m!.host.querySelector('.account-organization-error')?.textContent,
    ).toBe(
      "Couldn't switch organization. User is not a member of the organization.",
    );
    expect(store.ephemeral.account?.organization?.id).toBe('org_me');
    expect(row()?.textContent).toContain('Personal');
    // Still signed in, the switcher still there.
    expect(store.ephemeral.account?.user).not.toBeNull();
    expect(m!.host.querySelector('.account-organization-switch')).toBeTruthy();
  });
});

describe('Settings → Account, several accounts', () => {
  const jean: AccountEntry = {
    user: {
      id: 'user_01',
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      avatar_url: null,
    },
    organization: { id: 'org_me', role: 'admin' },
    organizations: [
      { id: 'org_me', name: "Ada's workspace", role: 'admin', personal: true },
    ],
    active: true,
    sign_in_required: false,
  };
  const work: AccountEntry = {
    user: {
      id: 'user_02',
      email: 'ada@acme.com',
      name: null,
      avatar_url: null,
    },
    organization: { id: 'org_acme', role: 'member' },
    organizations: [
      { id: 'org_acme', name: 'Acme', role: 'member', personal: false },
    ],
    active: false,
    sign_in_required: false,
  };
  const several = (accounts: AccountEntry[]): AccountStatus => {
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

  let transport: FakeTransport;
  let store: RootStore;

  beforeEach(() => {
    transport = new FakeTransport();
    setTransport(transport);
    store = new RootStore();
    transport.onCall('account_organizations', () => jean.organizations);
  });

  async function render(s: AccountStatus) {
    store.ephemeral.setAccount(s);
    transport.onCall('account_status', () => store.ephemeral.account);
    m = await mount(
      <RootStoreProvider store={store}>
        <AccountCard />
      </RootStoreProvider>,
    );
    await settle();
  }

  const called = (cmd: string) => transport.calls.filter((c) => c.cmd === cmd);
  const rows = () => [...m!.host.querySelectorAll<HTMLElement>('.account-row')];
  const rowOf = (user: string) =>
    m!.host.querySelector<HTMLElement>(`.account-row[data-user="${user}"]`);

  it('lists every account, the active one marked, the others with Switch', async () => {
    await render(several([jean, work]));
    expect(m!.host.textContent).toContain('Theodore accounts');
    expect(rows()).toHaveLength(2);
    expect(rowOf('user_01')?.textContent).toContain('Active');
    expect(rowOf('user_01')?.textContent).toContain('Personal');
    expect(rowOf('user_01')?.querySelector('.account-switch')).toBeNull();
    expect(rowOf('user_02')?.textContent).toContain('ada@acme.com');
    expect(rowOf('user_02')?.textContent).toContain('Acme');
    expect(rowOf('user_02')?.textContent).toContain('Member');
    expect(rowOf('user_02')?.querySelector('.account-switch')).toBeTruthy();
    expect(m!.host.querySelector('.account-add')).toBeTruthy();
    // The active account's organization switcher stays below the rows.
    expect(m!.host.querySelector('.account-organization')).toBeTruthy();
  });

  it('Switch makes that account active', async () => {
    await render(several([jean, work]));
    transport.onCall('account_switch', () =>
      several([
        { ...jean, active: false },
        { ...work, active: true },
      ]),
    );
    await click(rowOf('user_02')?.querySelector('.account-switch'));
    await settle();
    expect(called('account_switch')[0]?.args).toEqual({
      req: { user_id: 'user_02', organization_id: null },
    });
    expect(rowOf('user_02')?.textContent).toContain('Active');
    expect(rowOf('user_01')?.querySelector('.account-switch')).toBeTruthy();
  });

  it('signs one account out', async () => {
    await render(several([jean, work]));
    transport.onCall('account_sign_out_of', () => several([jean]));
    await click(rowOf('user_02')?.querySelector('.account-sign-out'));
    await settle();
    expect(called('account_sign_out_of')[0]?.args).toEqual({
      userId: 'user_02',
    });
    expect(rows()).toHaveLength(1);
  });

  it('offers Sign in again for an ended session, with the email', async () => {
    await render(several([jean, { ...work, sign_in_required: true }]));
    const row = rowOf('user_02');
    expect(row?.textContent).toContain('sign in again');
    expect(row?.querySelector('.account-switch')).toBeNull();
    await click(row?.querySelector('.account-sign-in-again'));
    expect(store.ui.modal).toBe('sign-in');
    expect(store.ui.modalTargets).toEqual(['ada@acme.com']);
  });

  it('Add another account opens the sign-in dialog', async () => {
    await render(several([jean]));
    expect(m!.host.textContent).toContain('Theodore account');
    expect(m!.host.textContent).not.toContain('Theodore accounts');
    await click(m!.host.querySelector('.account-add'));
    expect(store.ui.modal).toBe('sign-in');
  });

  it('a failed switch is said under the rows', async () => {
    await render(several([jean, work]));
    transport.onCall('account_switch', () => {
      throw Object.assign(new Error('x'), {
        code: 'account',
        message: 'account: network: timed out',
      });
    });
    await click(rowOf('user_02')?.querySelector('.account-switch'));
    await settle();
    expect(m!.host.textContent).toContain(
      "Couldn't switch organization: no connection. Try again.",
    );
    expect(rowOf('user_01')?.textContent).toContain('Active');
  });
});

describe('Settings → Account → Delete account', () => {
  const ada = {
    id: 'user_01',
    email: 'ada@example.com',
    name: 'Ada Lovelace',
    avatar_url: null,
  };
  const entry: AccountEntry = {
    user: ada,
    organization: { id: 'org_me', role: 'admin' },
    organizations: [],
    active: true,
    sign_in_required: false,
  };
  const signedIn: AccountStatus = {
    available: true,
    required: true,
    session_ended: false,
    user: ada,
    organization: entry.organization,
    accounts: [entry],
  };
  const signedOut: AccountStatus = {
    ...signedIn,
    user: null,
    organization: null,
    accounts: [],
  };

  let transport: FakeTransport;
  let store: RootStore;

  beforeEach(async () => {
    transport = new FakeTransport();
    setTransport(transport);
    store = new RootStore();
    transport.onCall('account_organizations', () => []);
    store.ephemeral.setAccount(signedIn);
    transport.onCall('account_status', () => store.ephemeral.account);
    m = await mount(
      <RootStoreProvider store={store}>
        <AccountCard />
      </RootStoreProvider>,
    );
    await settle();
  });

  const called = (cmd: string) => transport.calls.filter((c) => c.cmd === cmd);
  const dialog = () => document.querySelector<HTMLElement>('.delete-account');
  const confirmField = () =>
    document.querySelector<HTMLInputElement>('.account-delete-confirm');
  const doDelete = () =>
    document.querySelector<HTMLButtonElement>('.account-delete-do');

  async function open() {
    await click(m!.host.querySelector('.account-delete'));
    await settle();
  }

  it('opens a sheet that says what goes and what stays', async () => {
    expect(m!.host.querySelector('.account-delete')?.textContent).toContain(
      'Delete account',
    );
    await open();
    const text = dialog()?.textContent ?? '';
    expect(text).toContain('Delete your Theodore account?');
    expect(text).toContain('Organizations only you are in');
    expect(text).toContain('Your devices, fleet history and push tokens');
    expect(text).toContain('Your code, projects and spaces on your computers');
    expect(text).toContain('Your GitHub and agent accounts, untouched');
  });

  it('deletes only once DELETE is typed', async () => {
    await open();
    expect(doDelete()?.disabled).toBe(true);
    await typeInto(confirmField(), 'delete');
    expect(doDelete()?.disabled).toBe(true);
    await click(doDelete());
    expect(called('account_delete')).toHaveLength(0);
    await typeInto(confirmField(), 'DELETE');
    expect(doDelete()?.disabled).toBe(false);
  });

  it('on success: signed out, and the sign-in says the account was deleted', async () => {
    transport.onCall('account_delete', () => signedOut);
    await open();
    await typeInto(confirmField(), 'DELETE');
    await click(doDelete());
    await settle();
    expect(called('account_delete')).toHaveLength(1);
    expect(store.ephemeral.account?.user).toBeNull();
    expect(store.ephemeral.accountGate).toBe('locked');
    expect(store.ephemeral.accountDeleted).toBe(true);
    expect(dialog()).toBeNull();
    // Signing in again clears it.
    store.ephemeral.setAccount(signedIn);
    expect(store.ephemeral.accountDeleted).toBe(false);
  });

  it('on failure: says so, keeps the account, lets the user retry', async () => {
    transport.onCall('account_delete', () => {
      throw Object.assign(new Error('x'), {
        code: 'account',
        message: 'account: network: cloud v1/account failed (502)',
      });
    });
    await open();
    await typeInto(confirmField(), 'DELETE');
    await click(doDelete());
    await settle();
    expect(dialog()?.textContent).toContain("Couldn't reach Theodore");
    expect(store.ephemeral.account?.user?.id).toBe('user_01');
    expect(store.ephemeral.accountDeleted).toBe(false);
    expect(doDelete()?.disabled).toBe(false);
  });

  it('the sign-in screen says the account was deleted', async () => {
    const signIn: AccountSignIn = {
      flow: initialFlow,
      start: vi.fn(),
      cancel: vi.fn(),
      chooseOrganization: vi.fn(),
      reopen: vi.fn(),
    };
    m?.unmount();
    m = await mount(<SignInView signIn={signIn} user={null} deleted />);
    expect(m.host.textContent).toContain('Your account was deleted');
    expect(m.host.textContent).toContain('still here');
  });
});

describe('deleteErrorText', () => {
  it.each([
    [
      'account: network: cloud v1/account failed (502)',
      "Couldn't reach Theodore. Nothing was deleted yet — try again.",
    ],
    [
      'account: protocol: cloud.internal: boom',
      "Couldn't delete the account. Try again in a moment.",
    ],
  ])('%s', (raw, said) => expect(deleteErrorText(raw)).toBe(said));
});

describe('switchErrorText', () => {
  it.each([
    [
      'account: rejected: organization_not_found: Organization not found.',
      "Couldn't switch organization. Organization not found.",
    ],
    [
      'account: network: error sending request',
      "Couldn't switch organization: no connection. Try again.",
    ],
    ['account: rejected: ', "Couldn't switch organization."],
    ['something odd', "Couldn't switch organization. Something odd"],
  ])('%s', (raw, said) => expect(switchErrorText(raw)).toBe(said));
});
