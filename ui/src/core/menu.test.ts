import { beforeEach, describe, expect, it } from 'vitest';
import type { AccountStatus } from '../gen/contract';
import type { RootStore } from '../stores/RootStore';
import { EphemeralStore } from '../stores/EphemeralStore';
import { UiStore } from '../stores/UiStore';
import { NO_ACCOUNT } from './accountGate';
import { runMenu } from './menu';

beforeEach(() => localStorage.clear());

const store = (account: AccountStatus = NO_ACCOUNT) => {
  const ephemeral = new EphemeralStore();
  ephemeral.setAccount(account);
  return { ui: new UiStore(), ephemeral } as unknown as RootStore;
};

describe('runMenu: Go', () => {
  it('opens Pull requests, keeping its filter', () => {
    const s = store();
    s.ui.setPrsFilter('merged');
    runMenu(s, 'go-prs');
    expect(s.ui.route).toEqual({ name: 'prs' });
    expect(s.ui.prsFilter).toBe('merged');
  });

  it('opens Pull requests on Mine', () => {
    const s = store();
    runMenu(s, 'go-mine');
    expect(s.ui.route).toEqual({ name: 'prs' });
    expect(s.ui.prsFilter).toBe('mine');
  });
});

describe('runMenu behind the account gate', () => {
  const signedOut: AccountStatus = {
    available: true,
    required: true,
    user: null,
    session_ended: false,
  };

  it('does nothing that reaches the app', () => {
    const s = store(signedOut);
    const before = s.ui.route;
    for (const id of ['go-prs', 'settings', 'new-tab', 'add-project']) {
      runMenu(s, id);
    }
    runMenu(s, 'palette');
    expect(s.ui.route).toEqual(before);
    expect(s.ui.modal).toBeNull();
  });
});
