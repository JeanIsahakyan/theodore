import { describe, expect, it } from 'vitest';
import {
  AuthKitClient,
  REFRESH_SKEW_MS,
  refreshDelay,
  refreshRetryDelay,
  type BrowserResult,
  type Timers,
} from '../src/auth/client';
import { AuthError } from '../src/auth/errors';
import {
  memoryStore,
  parseStoredSession,
  serializeSession,
} from '../src/auth/store';
import type { Session } from '../src/auth/types';
import type { AccountApi, Authenticated } from '../src/auth/workos';
import { claims, makeKey, sign } from './auth-helpers';

const key = makeKey();
const T0 = 1_800_000_000_000;

let serial = 0;
function session(over: Partial<Session> = {}): Session {
  serial += 1;
  return {
    userId: 'user_1',
    email: 'a@b.c',
    name: 'Ada',
    accessToken: sign(key, claims({ sid: 'sid_1', n: serial })),
    refreshToken: `refresh_${serial}`,
    expiresAt: T0 + 5 * 60_000,
    organizationId: 'org_1',
    role: 'admin',
    ...over,
  };
}

/** Manual timers driven by `advance`. */
function fakeTimers(clock: { now: number }) {
  let id = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    set(fn, ms) {
      pending.set(++id, { at: clock.now + ms, fn });
      return id;
    },
    clear(h) {
      pending.delete(h as number);
    },
  };
  return {
    timers,
    pending,
    next(): number | null {
      const at = [...pending.values()]
        .map((p) => p.at)
        .sort((a, b) => a - b)[0];
      return at ?? null;
    },
    /** Moves the clock to the next timer and fires it. */
    async fireNext() {
      const entry = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) throw new Error('no timer');
      pending.delete(entry[0]);
      clock.now = entry[1].at;
      entry[1].fn();
      await flush();
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

type Fn<A extends unknown[], R> = (...a: A) => Promise<R>;

function fakeApi(over: Partial<AccountApi> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const rec =
    <A extends unknown[], R>(method: string, fn: Fn<A, R>): Fn<A, R> =>
    (...args: A) => {
      calls.push({ method, args });
      return fn(...args);
    };
  const unexpected = (m: string) => async () => {
    throw new Error(`unexpected ${m}`);
  };
  const api: AccountApi = {
    exchangeCode: rec(
      'exchangeCode',
      over.exchangeCode ?? unexpected('exchangeCode'),
    ),
    refresh: rec('refresh', over.refresh ?? unexpected('refresh')),
    selectOrganization: rec(
      'selectOrganization',
      over.selectOrganization ?? unexpected('selectOrganization'),
    ),
    ensurePersonalOrganization: rec(
      'ensurePersonalOrganization',
      over.ensurePersonalOrganization ??
        unexpected('ensurePersonalOrganization'),
    ),
    organizations: rec('organizations', over.organizations ?? (async () => [])),
    logout: rec('logout', over.logout ?? (async () => {})),
    deleteAccount: rec(
      'deleteAccount',
      over.deleteAccount ?? unexpected('deleteAccount'),
    ),
  };
  return { api, calls };
}

function setup(opts: {
  api?: Partial<AccountApi>;
  stored?: Session | null;
  browser?: (url: string) => Promise<BrowserResult>;
  subscribe?: boolean;
}) {
  const clock = { now: T0 };
  const t = fakeTimers(clock);
  const { api, calls } = fakeApi(opts.api);
  const store = memoryStore(opts.stored ? serializeSession(opts.stored) : null);
  let notify: (() => void) | null = null;
  if (opts.subscribe) {
    Object.assign(store, {
      subscribe(cb: () => void) {
        notify = cb;
        return () => {};
      },
    });
  }
  const opened: string[] = [];
  const warnings: string[] = [];
  const client = new AuthKitClient({
    api,
    store,
    apiBase: 'https://api.workos.test',
    clientId: 'client_test',
    redirectUri: () => 'theodore://callback',
    random: (n) => new Uint8Array(n).map(() => Math.floor(Math.random() * 256)),
    now: () => clock.now,
    timers: t.timers,
    warn: (m) => warnings.push(m),
    openBrowser: (url) => {
      opened.push(url);
      return opts.browser
        ? opts.browser(url)
        : Promise.resolve({ type: 'cancel' });
    },
  });
  const changes: (Session | null)[] = [];
  client.onChange((s) => changes.push(s));
  return {
    client,
    calls,
    store,
    clock,
    t,
    opened,
    warnings,
    changes,
    notify: () => notify?.(),
  };
}

/** A browser that comes back with `code` and the attempt's own state. */
const returnsCode =
  (code = 'code_1') =>
  async (url: string): Promise<BrowserResult> => {
    const state = new URL(url).searchParams.get('state');
    return {
      type: 'success',
      url: `theodore://callback?code=${code}&state=${state}`,
    };
  };

const ok = (s: Session): Authenticated => ({ kind: 'session', session: s });
const rejected = () => new AuthError('rejected', 'invalid_grant: nope');
const offline = () => new AuthError('network', 'offline');

describe('schedule', () => {
  it('refreshes 60 s before exp, never sooner than 5 s', () => {
    expect(refreshDelay(T0 + 5 * 60_000, T0)).toBe(4 * 60_000);
    expect(refreshDelay(T0, T0)).toBe(5_000);
  });

  it('backs off 30 s doubling to 10 min', () => {
    expect([1, 2, 3, 4, 5, 6, 50].map(refreshRetryDelay)).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000,
    ]);
  });
});

describe('stored session', () => {
  it('loads, validates and schedules', async () => {
    const s = session();
    const { client, t } = setup({ stored: s });
    expect(await client.current()).toEqual(s);
    expect(t.next()).toBe(s.expiresAt - REFRESH_SKEW_MS);
  });

  it('ignores a malformed entry', () => {
    expect(parseStoredSession('{"userId":"u"}')).toBeNull();
    expect(parseStoredSession('nope')).toBeNull();
    expect(parseStoredSession(null)).toBeNull();
  });
});

describe('sign-in', () => {
  it('exchanges the code and stores the session', async () => {
    const s = session();
    const { client, calls, store, changes, opened } = setup({
      browser: returnsCode('code_9'),
      api: { exchangeCode: async () => ok(s) },
    });
    const r = await client.signIn();
    expect(r).toEqual({ kind: 'signed_in', session: s });
    const verifier = calls[0].args[1] as string;
    expect(calls[0]).toEqual({
      method: 'exchangeCode',
      args: ['code_9', verifier],
    });
    expect(new URL(opened[0]).searchParams.get('code_challenge')).not.toBe(
      verifier,
    );
    expect(parseStoredSession(store.value)).toEqual(s);
    expect(changes.at(-1)).toEqual(s);
    expect(await client.accessToken()).toBe(s.accessToken);
  });

  it('opens the browser synchronously (web popups)', () => {
    const { client, opened } = setup({ browser: () => new Promise(() => {}) });
    void client.signIn();
    expect(opened).toHaveLength(1);
  });

  it('cancel, foreign state and provider errors', async () => {
    expect(await setup({}).client.signIn()).toEqual({ kind: 'cancelled' });
    const foreign = setup({
      browser: async () => ({
        type: 'success',
        url: 'theodore://callback?code=x&state=forged',
      }),
    });
    expect((await foreign.client.signIn()).kind).toBe('failed');
    expect(foreign.calls).toHaveLength(0);
    const denied = setup({
      browser: async (url) => ({
        type: 'success',
        url: `theodore://callback?error=access_denied&state=${new URL(url).searchParams.get('state')}`,
      }),
    });
    expect(await denied.client.signIn()).toEqual({ kind: 'cancelled' });
    const refused = setup({
      browser: returnsCode(),
      api: {
        exchangeCode: async () => {
          throw rejected();
        },
      },
    });
    expect((await refused.client.signIn()).kind).toBe('failed');
    expect(refused.store.value).toBeNull();
  });

  it('one sign-in at a time', async () => {
    const { client } = setup({ browser: () => new Promise(() => {}) });
    void client.signIn();
    expect((await client.signIn()).kind).toBe('failed');
  });

  it('with no org: personal org from the cloud, then refresh into it', async () => {
    const first = session({ organizationId: null, role: null });
    const inOrg = session({ organizationId: 'org_p', role: 'admin' });
    const { client, calls, changes } = setup({
      browser: returnsCode(),
      api: {
        exchangeCode: async () => ok(first),
        ensurePersonalOrganization: async () => 'org_p',
        refresh: async () => ok(inOrg),
      },
    });
    expect((await client.signIn()).kind).toBe('signed_in');
    await client.settled();
    expect(calls.map((c) => c.method)).toEqual([
      'exchangeCode',
      'ensurePersonalOrganization',
      'refresh',
    ]);
    expect(calls[1].args).toEqual([first.accessToken]);
    expect(calls[2].args).toEqual([first.refreshToken, 'org_p']);
    expect((await client.current())?.organizationId).toBe('org_p');
    expect(changes.map((s) => s?.organizationId)).toEqual([null, 'org_p']);
  });

  it('a failing org step never signs out', async () => {
    const first = session({ organizationId: null });
    for (const failure of [
      { ensurePersonalOrganization: async () => Promise.reject(offline()) },
      {
        ensurePersonalOrganization: async () => 'org_p',
        refresh: async () => Promise.reject(rejected()),
      },
    ] satisfies Partial<AccountApi>[]) {
      const { client, warnings } = setup({
        browser: returnsCode(),
        api: { exchangeCode: async () => ok(first), ...failure },
      });
      await client.signIn();
      await client.settled();
      expect(await client.current()).toEqual(first);
      expect(warnings.join()).toContain('personal organization');
    }
  });
});

describe('organization selection', () => {
  const orgs = [
    { id: 'org_a', name: 'A' },
    { id: 'org_b', name: 'B' },
  ];
  const selecting = (over: Partial<AccountApi> = {}) =>
    setup({
      browser: returnsCode(),
      api: {
        exchangeCode: async () => ({
          kind: 'select',
          selection: { pendingToken: 'pending_1', organizations: orgs },
        }),
        ...over,
      },
    });

  it('offers the orgs, then finishes through the cloud', async () => {
    const s = session({ organizationId: 'org_b' });
    const { client, calls, store } = selecting({
      selectOrganization: async () => s,
    });
    expect(await client.signIn()).toEqual({
      kind: 'choose_organization',
      organizations: orgs,
    });
    expect(store.value).toBeNull();
    expect(await client.chooseOrganization('org_b')).toEqual({
      kind: 'signed_in',
      session: s,
    });
    expect(calls.at(-1)).toEqual({
      method: 'selectOrganization',
      args: ['pending_1', 'org_b'],
    });
    expect(parseStoredSession(store.value)).toEqual(s);
  });

  it('only an offered org; the pending token is single-use', async () => {
    const { client } = selecting({
      selectOrganization: async () => Promise.reject(rejected()),
    });
    await client.signIn();
    expect((await client.chooseOrganization('org_x')).kind).toBe('failed');
    expect((await client.chooseOrganization('org_a')).kind).toBe('failed');
    const again = await client.chooseOrganization('org_a');
    expect(again).toEqual({
      kind: 'failed',
      message: 'This sign-in has expired. Sign in again.',
    });
  });
});

describe('refresh', () => {
  it('the refresher rotates before exp and reschedules', async () => {
    const s = session();
    const next = session({ expiresAt: T0 + 10 * 60_000 });
    const { client, calls, t, store } = setup({
      stored: s,
      api: { refresh: async () => ok(next) },
    });
    await client.current();
    await t.fireNext();
    expect(calls).toEqual([
      { method: 'refresh', args: [s.refreshToken, null] },
    ]);
    expect(parseStoredSession(store.value)).toEqual(next);
    expect(t.next()).toBe(next.expiresAt - REFRESH_SKEW_MS);
  });

  it('single-flight: concurrent callers share one rotation', async () => {
    const s = session({ expiresAt: T0 + 30_000 }); // inside the skew
    const next = session({ expiresAt: T0 + 10 * 60_000 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { client, calls } = setup({
      stored: s,
      api: {
        refresh: async () => {
          await gate;
          return ok(next);
        },
      },
    });
    const tokens = Promise.all([
      client.accessToken(),
      client.accessToken(),
      client.current().then((x) => x?.accessToken),
    ]);
    await flush();
    release();
    expect(await tokens).toEqual([
      next.accessToken,
      next.accessToken,
      next.accessToken,
    ]);
    expect(calls.filter((c) => c.method === 'refresh')).toHaveLength(1);
  });

  it('offline: session kept, retry with backoff, accessToken throws', async () => {
    const s = session();
    const { client, t, store } = setup({
      stored: s,
      api: { refresh: async () => Promise.reject(offline()) },
    });
    await client.current();
    await t.fireNext();
    const firstRetry = t.next()! - (s.expiresAt - REFRESH_SKEW_MS);
    expect(firstRetry).toBe(30_000);
    await t.fireNext();
    const secondRetry = t.next()! - (s.expiresAt - REFRESH_SKEW_MS + 30_000);
    expect(secondRetry).toBe(60_000);
    expect(parseStoredSession(store.value)).toEqual(s);
    expect(await client.current()).toEqual(s);
    await expect(client.accessToken()).rejects.toMatchObject({
      kind: 'network',
    });
  });

  it('rejected: signed out, store cleared, refresher stops', async () => {
    const s = session({ expiresAt: T0 + 30_000 });
    const { client, store, changes, t } = setup({
      stored: s,
      api: { refresh: async () => Promise.reject(rejected()) },
    });
    await expect(client.accessToken()).rejects.toMatchObject({
      kind: 'rejected',
    });
    expect(store.value).toBeNull();
    expect(changes.at(-1)).toBeNull();
    expect(t.pending.size).toBe(0);
    expect(await client.accessToken()).toBeNull();
  });

  it('a sign-out during a refresh drops its result', async () => {
    const s = session({ expiresAt: T0 + 30_000 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { client, store } = setup({
      stored: s,
      api: {
        refresh: async () => {
          await gate;
          return ok(session());
        },
      },
    });
    const pending = client.accessToken();
    await flush();
    await client.signOut();
    release();
    expect(await pending).toBeNull();
    expect(store.value).toBeNull();
  });

  it('another tab rotated first: adopt its session instead of signing out', async () => {
    const s = session({ expiresAt: T0 + 30_000 });
    const theirs = session({ expiresAt: T0 + 10 * 60_000 });
    const env = setup({
      stored: s,
      subscribe: true,
      api: {
        refresh: async () => {
          env.store.value = serializeSession(theirs);
          throw rejected();
        },
      },
    });
    expect(await env.client.accessToken()).toBe(theirs.accessToken);
    expect(parseStoredSession(env.store.value)).toEqual(theirs);
  });

  it('another tab signed out: so does this one', async () => {
    const s = session();
    const env = setup({ stored: s, subscribe: true });
    await env.client.current();
    env.store.value = null;
    env.notify();
    await flush();
    expect(await env.client.current()).toBeNull();
    expect(env.changes.at(-1)).toBeNull();
  });
});

describe('switch, list, sign-out', () => {
  it('switch refreshes into the org', async () => {
    const s = session();
    const next = session({ organizationId: 'org_2', role: 'member' });
    const { client, calls } = setup({
      stored: s,
      api: { refresh: async () => ok(next) },
    });
    expect(await client.switchOrganization('org_2')).toEqual(next);
    expect(calls.at(-1)?.args).toEqual([s.refreshToken, 'org_2']);
    expect((await client.current())?.organizationId).toBe('org_2');
  });

  it('a refused switch leaves the session alone', async () => {
    const s = session();
    const { client, store } = setup({
      stored: s,
      api: { refresh: async () => Promise.reject(rejected()) },
    });
    await expect(client.switchOrganization('org_2')).rejects.toMatchObject({
      kind: 'rejected',
    });
    expect(await client.current()).toEqual(s);
    expect(parseStoredSession(store.value)).toEqual(s);
  });

  it('organizations use the current token; signed out is an error', async () => {
    const s = session();
    const { client, calls } = setup({ stored: s });
    await client.organizations();
    expect(calls.at(-1)?.args).toEqual([s.accessToken]);
    await expect(setup({}).client.organizations()).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it('sign-out clears first, then logs out with the sid (best effort)', async () => {
    const s = session();
    const { client, calls, store, changes, t } = setup({
      stored: s,
      api: { logout: async () => Promise.reject(offline()) },
    });
    await client.current();
    await client.signOut();
    await flush();
    expect(store.value).toBeNull();
    expect(changes.at(-1)).toBeNull();
    expect(t.pending.size).toBe(0);
    expect(calls.at(-1)).toEqual({ method: 'logout', args: ['sid_1'] });
    expect(await client.current()).toBeNull();
  });
});

describe('deleteAccount', () => {
  it('deletes in the cloud with the access token, then forgets the session', async () => {
    const s = session();
    const { client, store, calls } = setup({
      stored: s,
      api: { deleteAccount: async () => {} },
    });
    await client.deleteAccount();
    expect(calls.find((c) => c.method === 'deleteAccount')?.args).toEqual([
      s.accessToken,
    ]);
    expect(calls.some((c) => c.method === 'logout')).toBe(false);
    expect(store.value).toBeNull();
    expect(await client.current()).toBeNull();
  });

  it('keeps the session when the cloud fails', async () => {
    const s = session();
    const { client, store } = setup({
      stored: s,
      api: {
        deleteAccount: async () => {
          throw new Error('down');
        },
      },
    });
    await expect(client.deleteAccount()).rejects.toThrow('down');
    expect(store.value).not.toBeNull();
  });
});
