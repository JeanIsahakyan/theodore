import { describe, expect, it } from 'vitest';
import type { AccountEntry, Space } from '../gen/contract';
import {
  actionKey,
  activeAccount,
  currentOrgLabel,
  listedOrganizations,
  parseActionKey,
  rowLabel,
  runningByAccount,
  runningLabel,
  shortName,
} from './accounts';

const entry = (over: Partial<AccountEntry> = {}): AccountEntry => ({
  user: {
    id: 'user_01',
    email: 'jean@example.com',
    name: 'Jean Isahakyan',
    avatar_url: null,
  },
  organization: { id: 'org_me', role: 'admin' },
  organizations: [
    { id: 'org_me', name: "Jean's workspace", role: 'admin', personal: true },
    { id: 'org_acme', name: 'Acme Studio', role: 'member', personal: false },
  ],
  active: true,
  sign_in_required: false,
  ...over,
});

describe('account rows', () => {
  it('names by first name, else email', () => {
    expect(shortName(entry().user)).toBe('Jean');
    expect(shortName({ ...entry().user, name: null })).toBe('jean@example.com');
    expect(shortName({ ...entry().user, name: '  ' })).toBe('jean@example.com');
  });

  it('calls the personal organization Personal and keeps team names', () => {
    expect(currentOrgLabel(entry())).toBe('Personal');
    expect(
      currentOrgLabel(entry({ organization: { id: 'org_acme', role: null } })),
    ).toBe('Acme Studio');
  });

  it('shows the row as "Jean · Personal", the name alone until known', () => {
    expect(rowLabel(entry())).toBe('Jean · Personal');
    expect(rowLabel(entry({ organizations: [] }))).toBe('Jean');
    expect(rowLabel(entry({ organization: null }))).toBe('Jean');
  });

  it('lists the current organization by id alone until the cloud answers', () => {
    expect(listedOrganizations(entry({ organizations: [] }))).toEqual([
      { id: 'org_me', name: 'Organization', role: 'admin', personal: false },
    ]);
    expect(
      listedOrganizations(entry({ organizations: [], organization: null })),
    ).toEqual([]);
  });

  it('finds the active account', () => {
    const a = entry({ active: false });
    const b = entry({ user: { ...a.user, id: 'user_02' } });
    expect(
      activeAccount({
        available: true,
        required: true,
        user: b.user,
        session_ended: false,
        organization: null,
        accounts: [a, b],
      })?.user.id,
    ).toBe('user_02');
    expect(activeAccount(null)).toBeNull();
  });
});

describe('running spaces per account', () => {
  const space = (over: Partial<Space>): Space =>
    ({
      id: 'x',
      status: 'running',
      account: 'user_02',
      ...over,
    }) as Space;

  it('counts running spaces by the account that made them', () => {
    const by = runningByAccount([
      space({ id: 'a' }),
      space({ id: 'b' }),
      space({ id: 'c', status: 'idle' }),
      space({ id: 'd', account: 'user_01' }),
      space({ id: 'e', account: null }),
      space({
        id: 'f',
        remote: {
          space: 'rs',
          host_device: 'd',
          host_name: 'h',
          project_name: 'p',
          started_here: true,
        },
      }),
    ]);
    expect(by.get('user_02')).toBe(2);
    expect(by.get('user_01')).toBe(1);
    expect(by.size).toBe(2);
  });

  it('says "N running", nothing at zero', () => {
    expect(runningLabel(2)).toBe('2 running');
    expect(runningLabel(0)).toBeNull();
    expect(runningLabel(undefined)).toBeNull();
  });
});

describe('popover action keys', () => {
  it('round-trip', () => {
    for (const a of [
      { kind: 'switch', userId: 'user_01', organizationId: 'org:a' },
      { kind: 'switch', userId: 'user_01', organizationId: null },
      { kind: 'sign-in-again', userId: 'user_02' },
      { kind: 'add' },
      { kind: 'settings' },
      { kind: 'report' },
      { kind: 'sign-out' },
    ] as const) {
      expect(parseActionKey(actionKey(a))).toEqual(a);
    }
    expect(parseActionKey('nonsense')).toBeNull();
    expect(parseActionKey('switch:')).toBeNull();
  });
});
