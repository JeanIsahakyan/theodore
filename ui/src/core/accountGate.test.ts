import { describe, expect, it } from 'vitest';
import type { AccountStatus } from '../gen/contract';
import { NO_ACCOUNT, accountGate, appView } from './accountGate';

const user = {
  id: 'u',
  email: 'ada@example.com',
  name: null,
  avatar_url: null,
};
const status = (s: Partial<AccountStatus>): AccountStatus => ({
  available: true,
  required: true,
  user: null,
  session_ended: false,
  ...s,
});

describe('accountGate', () => {
  it('is unknown until the status arrives', () => {
    expect(accountGate(null)).toBe('unknown');
  });

  it('locks while signed out where sign-in is required', () => {
    expect(accountGate(status({}))).toBe('locked');
    expect(accountGate(status({ session_ended: true }))).toBe('locked');
  });

  it('opens once signed in', () => {
    expect(accountGate(status({ user }))).toBe('open');
  });

  it('stays open without a configured account (dev build, sandbox, fixtures)', () => {
    expect(accountGate(NO_ACCOUNT)).toBe('open');
    expect(
      accountGate({ ...NO_ACCOUNT, available: true, required: false }),
    ).toBe('open');
  });
});

describe('appView', () => {
  it('waits for the account status', () => {
    expect(appView(true, 'unknown')).toBe('loading');
    expect(appView(false, 'unknown')).toBe('loading');
  });

  it('runs onboarding first, signed in or not', () => {
    expect(appView(false, 'locked')).toBe('onboarding');
    expect(appView(false, 'open')).toBe('onboarding');
  });

  it('shows only the sign-in once onboarded and signed out', () => {
    expect(appView(true, 'locked')).toBe('sign-in');
  });

  it('shows the app when the gate is open', () => {
    expect(appView(true, 'open')).toBe('app');
  });
});
