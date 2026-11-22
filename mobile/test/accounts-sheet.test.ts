import { describe, expect, it } from 'vitest';
import type { AccountView } from '../src/auth/types';
import {
  ADD_ACCOUNT,
  SIGN_IN_AGAIN,
  accountsRows,
  signOutPrompt,
  switchTarget,
} from '../src/ui/accountsSheet';
import { connectionBanner } from '../src/ui/connection';
import { LOADING_TEXT, loadingText } from '../src/ui/load';
import { accountsDetail } from '../src/ui/settingsView';

const jean: AccountView = {
  userId: 'u_a',
  label: 'Jean',
  initials: 'JI',
  email: 'jean@example.com',
  orgId: 'org_p',
  orgs: [
    { id: 'org_p', name: 'Personal' },
    { id: 'org_s', name: 'Acme Studio' },
  ],
  stale: false,
  active: true,
};

const work: AccountView = {
  userId: 'u_b',
  label: 'jean@acme.com',
  initials: 'J',
  email: 'jean@acme.com',
  orgId: 'org_a',
  orgs: [{ id: 'org_a', name: 'Acme Inc' }],
  stale: false,
  active: false,
};

describe('accounts sheet rows', () => {
  it('lists each account with its orgs, a check on the active org, add and sign out', () => {
    const rows = accountsRows([jean, work], 'org_p');
    expect(
      rows.map((r) => {
        switch (r.kind) {
          case 'account':
            return `${r.initials} ${r.label}${r.email ? ` <${r.email}>` : ''}${r.active ? ' *' : ''}`;
          case 'org':
            return `  ${r.name}${r.selected ? ' ✓' : ''}`;
          case 'reauth':
            return `  ${r.label}`;
          case 'add':
            return `+ ${r.label}`;
          case 'sign-out':
            return `--- ${r.label}`;
        }
      }),
    ).toEqual([
      'JI Jean <jean@example.com> *',
      '  Personal ✓',
      '  Acme Studio',
      // The label is the email already: not repeated under it.
      'J jean@acme.com',
      '  Acme Inc',
      `+ ${ADD_ACCOUNT}`,
      '--- Sign out of Jean',
    ]);
    const org = rows.find((r) => r.kind === 'org' && r.orgId === 'org_a');
    expect(org).toMatchObject({
      accessibilityLabel: 'Switch to Acme Inc of jean@acme.com',
    });
  });

  it('offers "Sign in again" for a stale account instead of its orgs', () => {
    const rows = accountsRows([jean, { ...work, stale: true }], 'org_p');
    expect(rows.filter((r) => r.kind === 'org').length).toBe(2);
    expect(rows.find((r) => r.kind === 'reauth')).toEqual({
      kind: 'reauth',
      userId: 'u_b',
      label: SIGN_IN_AGAIN,
    });
  });

  it('shows the org an account is in when the cloud has not listed its orgs yet', () => {
    const rows = accountsRows([{ ...work, orgs: [], active: true }], 'org_a');
    expect(rows.filter((r) => r.kind === 'org')).toEqual([
      {
        kind: 'org',
        userId: 'u_b',
        orgId: 'org_a',
        name: 'Organization',
        selected: true,
        accessibilityLabel: 'Switch to Organization of jean@acme.com',
      },
    ]);
  });

  it('has no sign-out row when nobody is active', () => {
    const rows = accountsRows([{ ...jean, active: false }], null);
    expect(rows.some((r) => r.kind === 'sign-out')).toBe(false);
  });

  it('names the switch target and the sign-out confirm', () => {
    expect(switchTarget(work, 'Acme Inc')).toBe('Acme Inc');
    expect(switchTarget(work, 'Organization')).toBe('jean@acme.com');
    expect(signOutPrompt('Jean').title).toBe(
      'Sign out of Jean on this device?',
    );
  });
});

describe('switching state wording', () => {
  it('says where it is going on Home and in the banner', () => {
    expect(loadingText(null)).toBe(LOADING_TEXT);
    expect(loadingText('Acme Inc')).toBe('Switching to Acme Inc…');
    expect(connectionBanner('connecting', null, false, 'Acme Inc')).toEqual({
      tone: 'neutral',
      text: 'Switching to Acme Inc…',
      busy: true,
    });
    expect(connectionBanner('connecting', null, false, null)).toBeNull();
    expect(connectionBanner('connected', null, true, 'Acme Inc')).toBeNull();
  });

  it('counts accounts on the Settings row only from two', () => {
    expect(accountsDetail(1)).toBe('');
    expect(accountsDetail(3)).toBe('3');
  });
});
