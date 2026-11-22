import { describe, expect, it } from 'vitest';
import {
  ACCOUNTS_KEY,
  ACCOUNTS_MAX,
  EMPTY_INDEX,
  LEGACY_SESSION_KEY,
  PUSH_SWEEP_EVERY_MS,
  accountKey,
  accountLabel,
  accountLine,
  activate,
  nextActive,
  parseAccountIndex,
  pushSweepDue,
  recordFromSession,
  recordOrgs,
  removeAccount,
  serializeAccountIndex,
  upsertAccount,
  type AccountIndex,
} from '../src/auth/accounts';
import { AuthKitClient } from '../src/auth/client';
import { AuthError } from '../src/auth/errors';
import { MultiAccountClient, type AccountKV } from '../src/auth/multi';
import { serializeSession, type SessionStore } from '../src/auth/store';
import type { Session } from '../src/auth/types';
import type { AccountApi, Authenticated } from '../src/auth/workos';

const T0 = 1_800_000_000_000;

function session(userId: string, org: string | null, n = 1): Session {
  return {
    userId,
    email: `${userId}@example.com`,
    name: userId === 'u_a' ? 'Ada Lovelace' : null,
    accessToken: `at-${userId}-${org}-${n}`,
    refreshToken: `rt-${userId}-${n}`,
    expiresAt: T0 + 60 * 60_000,
    organizationId: org,
    role: null,
  };
}

// ── the index ───────────────────────────────────────────────────────────────

describe('account index', () => {
  it('adds, keeps orgs across a re-sign-in, caps the count', () => {
    let i = upsertAccount(EMPTY_INDEX, session('u_a', 'org_1'), T0);
    i = recordOrgs(i, 'u_a', [{ id: 'org_1', name: 'Personal' }]);
    i = upsertAccount(i, session('u_b', 'org_2'), T0 + 1);
    expect(i.active).toBe('u_b');
    expect(i.accounts.map((a) => a.userId)).toEqual(['u_a', 'u_b']);
    // Signing in again as u_a: same record, orgs kept, active, not stale.
    i = { ...i, accounts: i.accounts.map((a) => ({ ...a, stale: true })) };
    i = upsertAccount(i, session('u_a', 'org_1'), T0 + 2);
    expect(i.active).toBe('u_a');
    expect(i.accounts.find((a) => a.userId === 'u_a')).toMatchObject({
      stale: false,
      orgs: [{ id: 'org_1', name: 'Personal' }],
    });
    for (let n = 0; n < ACCOUNTS_MAX + 3; n++)
      i = upsertAccount(i, session(`u_${n}`, 'o'), T0 + 10 + n);
    expect(i.accounts.length).toBe(ACCOUNTS_MAX);
    // The least recently used went first.
    expect(i.accounts.some((a) => a.userId === 'u_b')).toBe(false);
  });

  it('picks the next account after a sign-out: most recently used, not stale', () => {
    let i = upsertAccount(EMPTY_INDEX, session('u_a', 'o'), T0);
    i = upsertAccount(i, session('u_b', 'o'), T0 + 1);
    i = upsertAccount(i, session('u_c', 'o'), T0 + 2);
    i = activate(i, 'u_a', T0 + 3);
    expect(i.active).toBe('u_a');
    i = {
      ...i,
      accounts: i.accounts.map((a) =>
        a.userId === 'u_c' ? { ...a, stale: true } : a,
      ),
    };
    const after = removeAccount(i, 'u_a');
    expect(after.accounts.map((a) => a.userId)).toEqual(['u_b', 'u_c']);
    // u_c was used more recently but can't sign requests: u_b.
    expect(after.active).toBe('u_b');
    // Removing an inactive account leaves the active one.
    expect(removeAccount(i, 'u_b').active).toBe('u_a');
    expect(nextActive(EMPTY_INDEX)).toBeNull();
    expect(
      removeAccount(upsertAccount(EMPTY_INDEX, session('u_a', 'o'), T0), 'u_a'),
    ).toEqual(EMPTY_INDEX);
  });

  it('survives a round trip and rejects what is not an index', () => {
    let i = upsertAccount(EMPTY_INDEX, session('u_a', 'org_1'), T0);
    i = recordOrgs(i, 'u_a', [{ id: 'org_1', name: 'Personal' }]);
    expect(parseAccountIndex(serializeAccountIndex(i))).toEqual(i);
    expect(parseAccountIndex(null)).toBeNull();
    expect(parseAccountIndex('nope')).toBeNull();
    expect(parseAccountIndex('{"v":1,"accounts":"x"}')).toBeNull();
    // An active id that names nobody is dropped; duplicates too.
    const odd: AccountIndex = {
      active: 'ghost',
      accounts: [
        recordFromSession(session('u_a', 'o'), T0),
        recordFromSession(session('u_a', 'o'), T0),
      ],
    };
    const back = parseAccountIndex(serializeAccountIndex(odd));
    expect(back?.active).toBeNull();
    expect(back?.accounts.length).toBe(1);
  });

  it('stores each account under its own key, apart from the old single one', () => {
    expect(accountKey('user_01ABC')).toBe('theodore.account.user_01ABC');
    expect(accountKey('a/b c')).toBe('theodore.account.a_b_c');
    expect(accountKey('x')).not.toBe(LEGACY_SESSION_KEY);
    expect(ACCOUNTS_KEY).toBe('theodore.accounts');
  });

  it('names the account and the drawer row', () => {
    const rec = recordFromSession(session('u_a', 'org_1'), T0);
    expect(accountLabel(rec)).toBe('Ada Lovelace');
    expect(accountLabel({ name: null, email: 'x@y.z' })).toBe('x@y.z');
    expect(accountLabel({ name: ' ', email: '' })).toBe('Signed in');
    expect(accountLine(rec)).toBe('Ada Lovelace');
    expect(
      accountLine({ ...rec, orgs: [{ id: 'org_1', name: 'Personal' }] }),
    ).toBe('Ada Lovelace · Personal');
    expect(accountLine(rec, 'Acme')).toBe('Ada Lovelace · Acme');
  });

  it('sweeps pushes at most once a day, never for a stale account', () => {
    const rec = recordFromSession(session('u_a', 'o'), T0);
    expect(pushSweepDue(rec, T0)).toBe(true);
    const swept = { ...rec, pushSweptAt: T0 };
    expect(pushSweepDue(swept, T0 + PUSH_SWEEP_EVERY_MS - 1)).toBe(false);
    expect(pushSweepDue(swept, T0 + PUSH_SWEEP_EVERY_MS)).toBe(true);
    expect(pushSweepDue({ ...rec, stale: true }, T0)).toBe(false);
  });
});

// ── the client ──────────────────────────────────────────────────────────────

function memoryKV(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  const kv: AccountKV & { map: Map<string, string> } = {
    map: m,
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => {
      m.set(k, v);
    },
    remove: async (k) => {
      m.delete(k);
    },
  };
  return kv;
}

/**
 * A fake WorkOS: refresh tokens name their user ("rt-<user>-<n>"); a
 * refresh rotates to n+1 in the org asked for (or the token's). Users in
 * `rejected` can't refresh. Sign-ins come back as `nextSignIn` says.
 */
function fakeApi() {
  const calls: { method: string; args: unknown[] }[] = [];
  const rejected = new Set<string>();
  let nextSignIn: Authenticated | null = null;
  const orgs: Record<string, { id: string; name: string }[]> = {};
  const parse = (rt: string) => {
    const m = /^rt-(u_\w+)-(\d+)$/.exec(rt);
    if (!m) throw new AuthError('rejected', 'invalid_grant: unknown token');
    return { userId: m[1], n: Number(m[2]) };
  };
  const api: AccountApi = {
    async exchangeCode(code, verifier) {
      calls.push({ method: 'exchangeCode', args: [code, verifier] });
      if (!nextSignIn) throw new AuthError('rejected', 'no sign-in staged');
      const r = nextSignIn;
      nextSignIn = null;
      return r;
    },
    async refresh(refreshToken, organizationId) {
      calls.push({ method: 'refresh', args: [refreshToken, organizationId] });
      const { userId, n } = parse(refreshToken);
      if (rejected.has(userId))
        throw new AuthError('rejected', 'invalid_grant: revoked');
      const org = organizationId ?? `org_of_${userId}`;
      return { kind: 'session', session: session(userId, org, n + 1) };
    },
    async selectOrganization() {
      throw new Error('unexpected');
    },
    async ensurePersonalOrganization() {
      throw new Error('unexpected');
    },
    async organizations(accessToken) {
      calls.push({ method: 'organizations', args: [accessToken] });
      const userId = /^at-(u_\w+)-/.exec(accessToken)?.[1] ?? '';
      return (orgs[userId] ?? []).map((o) => ({
        ...o,
        role: null,
        personal: false,
      }));
    },
    async logout(sid) {
      calls.push({ method: 'logout', args: [sid] });
    },
    async deleteAccount(accessToken) {
      calls.push({ method: 'deleteAccount', args: [accessToken] });
    },
  };
  return {
    api,
    calls,
    rejected,
    orgs,
    stage(r: Authenticated) {
      nextSignIn = r;
    },
  };
}

function setup(
  opts: {
    kv?: ReturnType<typeof memoryKV>;
    hooks?: ConstructorParameters<typeof MultiAccountClient>[0]['hooks'];
  } = {},
) {
  const kv = opts.kv ?? memoryKV();
  const fake = fakeApi();
  const clock = { now: T0 };
  const made: { store: SessionStore; autoRefresh: boolean }[] = [];
  const warnings: string[] = [];
  const browserState = { url: '' };
  const client = new MultiAccountClient({
    kv,
    hooks: opts.hooks,
    now: () => clock.now,
    warn: (m) => warnings.push(m),
    make: (store, autoRefresh) => {
      made.push({ store, autoRefresh });
      return new AuthKitClient({
        api: fake.api,
        store,
        apiBase: 'https://api.workos.test',
        clientId: 'client_test',
        redirectUri: () => 'theodore://callback',
        random: (n) => new Uint8Array(n).map(() => 7),
        now: () => clock.now,
        timers: { set: () => 0, clear: () => {} },
        autoRefresh,
        openBrowser: async (url) => {
          browserState.url = url;
          const state = new URL(url).searchParams.get('state');
          return {
            type: 'success',
            url: `theodore://callback?code=c&state=${state}`,
          };
        },
      });
    },
  });
  const changes: (Session | null)[] = [];
  client.onChange((s) => changes.push(s));
  const lists: string[][] = [];
  client.onAccountsChange((a) =>
    lists.push(a.map((x) => `${x.userId}${x.active ? '*' : ''}`)),
  );
  return {
    client,
    kv,
    fake,
    clock,
    made,
    changes,
    lists,
    warnings,
    browserState,
  };
}

/** Signs `userId` in through the hosted page (the fake exchange). */
async function signIn(
  t: ReturnType<typeof setup>,
  userId: string,
  org: string,
) {
  t.fake.stage({ kind: 'session', session: session(userId, org) });
  const r = await t.client.signIn();
  expect(r.kind).toBe('signed_in');
  return r;
}

describe('MultiAccountClient', () => {
  it('adds accounts: each in its own store entry, the newest active', async () => {
    const t = setup();
    expect(await t.client.current()).toBeNull();
    await signIn(t, 'u_a', 'org_1');
    expect((await t.client.current())?.userId).toBe('u_a');
    await signIn(t, 'u_b', 'org_2');
    expect((await t.client.current())?.userId).toBe('u_b');
    expect(t.kv.map.has(accountKey('u_a'))).toBe(true);
    expect(t.kv.map.has(accountKey('u_b'))).toBe(true);
    expect(t.kv.map.has(LEGACY_SESSION_KEY)).toBe(false);
    const index = parseAccountIndex(t.kv.map.get(ACCOUNTS_KEY) ?? null);
    expect(index?.active).toBe('u_b');
    expect(index?.accounts.map((a) => a.userId)).toEqual(['u_a', 'u_b']);
    expect(
      t.client.accounts().map((a) => [a.userId, a.active, a.label]),
    ).toEqual([
      ['u_a', false, 'Ada Lovelace'],
      ['u_b', true, 'u_b@example.com'],
    ]);
    // The app saw both sessions as they became active.
    expect(t.changes.map((s) => s?.userId)).toEqual(['u_a', 'u_b']);
    // Only the active account's client runs the background refresher.
    expect(t.made.filter((m) => m.autoRefresh).length).toBe(0);
    expect(t.lists.at(-1)).toEqual(['u_a', 'u_b*']);
  });

  it('switches to another account (and org), rotating that account only', async () => {
    const t = setup();
    await signIn(t, 'u_a', 'org_1');
    await signIn(t, 'u_b', 'org_2');
    t.fake.calls.length = 0;
    const s = await t.client.switchTo('u_a', 'org_3');
    expect(s.userId).toBe('u_a');
    expect(s.organizationId).toBe('org_3');
    expect(t.fake.calls).toEqual([
      { method: 'refresh', args: ['rt-u_a-1', 'org_3'] },
    ]);
    expect((await t.client.current())?.organizationId).toBe('org_3');
    expect(t.changes.at(-1)?.userId).toBe('u_a');
    expect(t.client.accounts().find((a) => a.active)?.userId).toBe('u_a');
    // Back to u_b: it is still in org_2, nothing to refresh.
    t.fake.calls.length = 0;
    await t.client.switchTo('u_b');
    expect(t.fake.calls).toEqual([]);
    expect((await t.client.current())?.userId).toBe('u_b');
    // A switch within the active account goes through it and is recorded.
    await t.client.switchOrganization('org_9');
    expect(t.client.accounts().find((a) => a.userId === 'u_b')?.orgId).toBe(
      'org_9',
    );
    expect(t.changes.at(-1)?.organizationId).toBe('org_9');
  });

  it('signs out the active account only; the next one takes over', async () => {
    const removed: string[][] = [];
    const before: string[] = [];
    const t = setup({
      hooks: {
        async beforeSignOut(userId, _client, orgs) {
          before.push(userId, ...orgs);
        },
        onRemoved(userId, orgs) {
          removed.push([userId, ...orgs]);
        },
      },
    });
    await signIn(t, 'u_a', 'org_1');
    await signIn(t, 'u_b', 'org_2');
    await t.client.signOut();
    expect(before).toEqual(['u_b', 'org_2']);
    expect(removed).toEqual([['u_b', 'org_2']]);
    expect(t.kv.map.has(accountKey('u_b'))).toBe(false);
    expect(t.kv.map.has(accountKey('u_a'))).toBe(true);
    expect((await t.client.current())?.userId).toBe('u_a');
    expect(t.changes.at(-1)?.userId).toBe('u_a');
    expect(t.client.accounts().map((a) => a.userId)).toEqual(['u_a']);
    // The last one out: signed out for good.
    await t.client.signOut();
    expect(await t.client.current()).toBeNull();
    expect(t.changes.at(-1)).toBeNull();
    expect(t.client.accounts()).toEqual([]);
    expect(t.kv.map.has(ACCOUNTS_KEY)).toBe(true);
  });

  it('marks an account whose refresh is rejected as stale and moves on', async () => {
    const t = setup();
    await signIn(t, 'u_a', 'org_1');
    await signIn(t, 'u_b', 'org_2');
    await t.client.switchTo('u_a');
    // u_a's token expires and WorkOS refuses the refresh.
    t.clock.now = T0 + 2 * 60 * 60_000;
    t.fake.rejected.add('u_a');
    const s = await t.client.current();
    // The app runs as u_b now; u_a stays listed, to be signed in again.
    expect(s?.userId).toBe('u_b');
    const a = t.client.accounts().find((x) => x.userId === 'u_a');
    expect(a?.stale).toBe(true);
    expect(a?.active).toBe(false);
    await expect(t.client.switchTo('u_a')).rejects.toThrow(/Sign in again/);
    // Signing in again replaces it (a new refresh token); the hint is its email.
    t.fake.rejected.delete('u_a');
    t.fake.stage({ kind: 'session', session: session('u_a', 'org_1', 5) });
    const r = await t.client.signInAgain('u_a');
    expect(r.kind).toBe('signed_in');
    expect(new URL(t.browserState.url).searchParams.get('login_hint')).toBe(
      'u_a@example.com',
    );
    expect(t.client.accounts().find((x) => x.userId === 'u_a')).toMatchObject({
      stale: false,
      active: true,
    });
    expect((await t.client.current())?.userId).toBe('u_a');
  });

  it('a stale inactive account stays until it is signed in again', async () => {
    const t = setup();
    await signIn(t, 'u_a', 'org_1');
    await signIn(t, 'u_b', 'org_2');
    // Both tokens expired; only u_a's refresh is refused.
    t.clock.now = T0 + 2 * 60 * 60_000;
    t.fake.rejected.add('u_a');
    await expect(t.client.switchTo('u_a')).rejects.toThrow();
    // Not switched: still u_b, u_a flagged.
    expect((await t.client.current())?.userId).toBe('u_b');
    expect(t.client.accounts().find((x) => x.userId === 'u_a')?.stale).toBe(
      true,
    );
  });

  it('adopts the single session of an older build as the first account', async () => {
    const legacy = session('u_old', 'org_1');
    const kv = memoryKV({ [LEGACY_SESSION_KEY]: serializeSession(legacy) });
    const t = setup({ kv });
    expect((await t.client.current())?.userId).toBe('u_old');
    expect(kv.map.has(LEGACY_SESSION_KEY)).toBe(false);
    expect(kv.map.has(accountKey('u_old'))).toBe(true);
    expect(t.client.accounts()).toMatchObject([
      { userId: 'u_old', active: true },
    ]);
  });

  it('remembers each account’s organizations and hands a new one to the hook', async () => {
    const seen: [string, string[]][] = [];
    const t = setup({
      hooks: {
        async beforeActivate(userId, _client, orgs) {
          seen.push([userId, orgs]);
        },
      },
    });
    t.fake.orgs.u_a = [
      { id: 'org_1', name: 'Personal' },
      { id: 'org_2', name: 'Acme' },
    ];
    await signIn(t, 'u_a', 'org_1');
    expect(seen).toEqual([['u_a', ['org_1', 'org_2']]]);
    expect(t.client.accounts()[0].orgs).toEqual([
      { id: 'org_1', name: 'Personal' },
      { id: 'org_2', name: 'Acme' },
    ]);
    // The hook may have moved the session around: it is back in org_1.
    expect((await t.client.current())?.organizationId).toBe('org_1');
    expect(await t.client.loadOrganizations('u_a')).toEqual(
      t.client.accounts()[0].orgs,
    );
  });

  it('notes a push sweep per account', async () => {
    const t = setup();
    await signIn(t, 'u_a', 'org_1');
    expect(t.client.pushSweepDue('u_a', T0)).toBe(true);
    await t.client.notePushSwept('u_a', T0);
    expect(t.client.pushSweepDue('u_a', T0 + 1000)).toBe(false);
    expect(t.client.pushSweepDue('u_a', T0 + PUSH_SWEEP_EVERY_MS)).toBe(true);
    const stored = parseAccountIndex(t.kv.map.get(ACCOUNTS_KEY) ?? null);
    expect(stored?.accounts[0].pushSweptAt).toBe(T0);
  });
});
