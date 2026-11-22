import { describe, expect, it } from 'vitest';
import type { AccountView, AuthClient, Session } from '../src/auth/types';
import { savedScope } from '../src/fleet/saved';
import type { FleetSnapshot } from '../src/fleet/types';
import { accountScopes, pushTarget, type ScopeSpaces } from '../src/push/route';
import { registerPushIn, type SweepFleet } from '../src/push/sweep';

const account = (
  userId: string,
  orgId: string,
  over: Partial<AccountView> = {},
): AccountView => ({
  userId,
  label: userId,
  initials: 'XX',
  email: `${userId}@example.com`,
  orgId,
  orgs: [],
  stale: false,
  active: false,
  ...over,
});

const set = (userId: string, orgId: string, spaces: string[]): ScopeSpaces => ({
  userId,
  orgId,
  scope: savedScope(userId, orgId),
  spaces,
});

describe('which account a push belongs to', () => {
  it('lists every <user>.<org> an account may have spaces in, once', () => {
    const scopes = accountScopes([
      account('u_a', 'org_1', {
        orgs: [
          { id: 'org_1', name: 'Personal' },
          { id: 'org_2', name: 'Acme' },
        ],
      }),
      account('u_b', 'org_2'),
    ]);
    expect(scopes.map((s) => s.scope)).toEqual([
      'u_a.org_1',
      'u_a.org_2',
      'u_b.org_2',
    ]);
  });

  it('opens here when the active org has the space, or nobody does', () => {
    const sets = [
      set('u_a', 'org_1', ['rs_1']),
      set('u_b', 'org_2', ['rs_1', 'rs_2']),
    ];
    const active = { userId: 'u_a', orgId: 'org_1' };
    expect(pushTarget('rs_1', sets, active)).toEqual({ kind: 'here' });
    expect(pushTarget('rs_new', sets, active)).toEqual({ kind: 'here' });
    expect(pushTarget('rs_1', sets, null)).toEqual({
      kind: 'switch',
      userId: 'u_a',
      orgId: 'org_1',
    });
  });

  it('switches to the account and org that have the space', () => {
    const sets = [
      set('u_a', 'org_1', ['rs_1']),
      set('u_a', 'org_3', ['rs_3']),
      set('u_b', 'org_2', ['rs_2']),
    ];
    const active = { userId: 'u_a', orgId: 'org_1' };
    expect(pushTarget('rs_2', sets, active)).toEqual({
      kind: 'switch',
      userId: 'u_b',
      orgId: 'org_2',
    });
    // Another org of the active account counts as a switch too.
    expect(pushTarget('rs_3', sets, active)).toEqual({
      kind: 'switch',
      userId: 'u_a',
      orgId: 'org_3',
    });
  });
});

// ── the sweep ───────────────────────────────────────────────────────────────

function fakeAccount(org: string) {
  let current: Session = {
    userId: 'u_a',
    email: 'a@b.c',
    name: null,
    accessToken: `at-${org}`,
    refreshToken: 'rt',
    expiresAt: Date.now() + 3_600_000,
    organizationId: org,
    role: null,
  };
  const switches: string[] = [];
  const auth: AuthClient = {
    current: async () => current,
    accessToken: async () => current.accessToken,
    signIn: async () => ({ kind: 'cancelled' }),
    chooseOrganization: async () => ({ kind: 'cancelled' }),
    switchOrganization: async (id) => {
      switches.push(id);
      if (id === 'org_bad')
        throw new Error('organization_membership_not_found');
      current = { ...current, organizationId: id, accessToken: `at-${id}` };
      return current;
    },
    organizations: async () => [],
    signOut: async () => {},
    deleteAccount: async () => {},
    onChange: () => () => {},
  };
  return { auth, switches, org: () => current.organizationId };
}

function fakeFleets(opts: { unreachable?: string[] } = {}) {
  const log: string[] = [];
  const make = (auth: AuthClient): SweepFleet => {
    let listener: ((s: FleetSnapshot['connection']) => void) | null = null;
    let org = '';
    return {
      async start() {
        org = (await auth.current())?.organizationId ?? '';
        log.push(`start ${org}`);
        // The hub answers on the next tick.
        setTimeout(() => {
          listener?.(opts.unreachable?.includes(org) ? 'error' : 'connected');
        }, 1);
      },
      async registerPush(token) {
        log.push(`register ${org} ${token === '' ? '(none)' : token}`);
      },
      onLink(l) {
        listener = l;
        return () => {
          listener = null;
        };
      },
      dispose() {
        log.push(`dispose ${org}`);
      },
    };
  };
  return { make, log };
}

describe('registering the push token in an account’s orgs', () => {
  const fast = { settleMs: 0, connectMs: 50 };

  it('connects as the account in each org, registers, disconnects', async () => {
    const acc = fakeAccount('org_1');
    const fleets = fakeFleets();
    const r = await registerPushIn(
      acc.auth,
      ['org_1', 'org_2'],
      'ExponentPushToken[x]',
      fleets.make,
      fast,
    );
    expect(r).toEqual({ done: ['org_1', 'org_2'], skipped: [] });
    // Already in org_1: no refresh; org_2 needs one.
    expect(acc.switches).toEqual(['org_2']);
    expect(fleets.log).toEqual([
      'start org_1',
      'register org_1 ExponentPushToken[x]',
      'dispose org_1',
      'start org_2',
      'register org_2 ExponentPushToken[x]',
      'dispose org_2',
    ]);
  });

  it('removes the token with "" at sign-out', async () => {
    const acc = fakeAccount('org_2');
    const fleets = fakeFleets();
    await registerPushIn(acc.auth, ['org_2'], '', fleets.make, fast);
    expect(fleets.log).toContain('register org_2 (none)');
  });

  it('skips an org it can’t switch to or reach, and goes on', async () => {
    const acc = fakeAccount('org_1');
    const fleets = fakeFleets({ unreachable: ['org_3'] });
    const r = await registerPushIn(
      acc.auth,
      ['org_bad', 'org_3', 'org_1'],
      't',
      fleets.make,
      fast,
    );
    expect(r.skipped).toEqual(['org_bad', 'org_3']);
    expect(r.done).toEqual(['org_1']);
    // The unreachable org's client was still disposed; nothing registered there.
    expect(fleets.log.filter((l) => l.startsWith('register'))).toEqual([
      'register org_1 t',
    ]);
    expect(fleets.log).toContain('dispose org_3');
  });
});
