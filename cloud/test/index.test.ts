import { describe, expect, it } from 'vitest';
import { remoteKeys, verifyAccessToken } from '../src/auth';
import worker, { depsFor, handle, type Deps } from '../src/index';
import { WorkosError } from '../src/workos';
import { FakeWorkos } from './fake-workos';
import { API, CLIENT, signer } from './keys';

describe('handle', async () => {
  const { keys, sign } = await signer();
  const workos = new FakeWorkos();
  const deps = (): Deps => ({
    workos,
    clientId: CLIENT,
    verify: (t) =>
      verifyAccessToken(t, { apiBase: API, clientId: CLIENT, keys }),
  });
  const call = (path: string, init: RequestInit = {}) =>
    handle(new Request(`https://cloud.test${path}`, init), deps);
  const errorCode = async (r: Response) =>
    ((await r.json()) as { error: { code: string } }).error.code;

  it('answers health without auth', async () => {
    const r = await call('/v1/health');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses /v1/orgs/personal without a token', async () => {
    const r = await call('/v1/orgs/personal', { method: 'POST' });
    expect(r.status).toBe(401);
    expect(await errorCode(r)).toBe('cloud.unauthorized');
  });

  it('refuses a forged token', async () => {
    const other = await signer();
    const t = await other.sign({ sub: 'user_1' });
    const r = await call('/v1/orgs/personal', {
      method: 'POST',
      headers: { authorization: `Bearer ${t}` },
    });
    expect(r.status).toBe(401);
  });

  it('ensures the caller’s personal org', async () => {
    const t = await sign({ sub: 'user_9' });
    const r = await call('/v1/orgs/personal', {
      method: 'POST',
      headers: { authorization: `Bearer ${t}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      organization_id: string;
      created: boolean;
    };
    expect(body.created).toBe(true);
    expect(
      workos.orgs.find((o) => o.id === body.organization_id)?.external_id,
    ).toBe('personal:user_9');
  });

  it('lists the caller’s orgs', async () => {
    const t = await sign({ sub: 'user_9' });
    const r = await call('/v1/orgs', {
      headers: { authorization: `Bearer ${t}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      organizations: Array<{ personal: boolean; role: string }>;
    };
    expect(body.organizations).toEqual([
      expect.objectContaining({ personal: true, role: 'admin' }),
    ]);
  });

  it('refuses /v1/orgs without a token', async () => {
    expect((await call('/v1/orgs')).status).toBe(401);
  });

  it('maps a WorkOS failure to 502 cloud.workos', async () => {
    workos.failWith = new WorkosError(500, undefined, 'WorkOS down');
    const t = await sign({ sub: 'user_10' });
    const r = await call('/v1/orgs/personal', {
      method: 'POST',
      headers: { authorization: `Bearer ${t}` },
    });
    workos.failWith = undefined;
    expect(r.status).toBe(502);
    expect(await errorCode(r)).toBe('cloud.workos');
  });

  const select = (body: unknown) =>
    call('/v1/auth/select-organization', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('finishes an org selection with our client id', async () => {
    const r = await select({
      pending_authentication_token: 'p1',
      organization_id: 'org_7',
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      user: { id: 'user_1', email: 'u@example.test' },
      organization_id: 'org_7',
      access_token: 'at',
      refresh_token: 'rt',
    });
    expect(workos.selections.at(-1)).toEqual({
      clientId: CLIENT,
      pending: 'p1',
      org: 'org_7',
    });
  });

  it('passes a rejected selection as 400 cloud.rejected', async () => {
    const r = await select({
      pending_authentication_token: 'used',
      organization_id: 'org_7',
    });
    expect(r.status).toBe(400);
    expect(await errorCode(r)).toBe('cloud.rejected');
  });

  it.each([
    ['not json', 'nope'],
    ['an array', [1]],
    ['no token', { organization_id: 'org_7' }],
    ['empty org', { pending_authentication_token: 'p', organization_id: '' }],
    ['a number', { pending_authentication_token: 5, organization_id: 'org_7' }],
  ])('refuses %s', async (_, body) => {
    const r = await select(body);
    expect(r.status).toBe(400);
    expect(await errorCode(r)).toBe('cloud.bad_request');
  });

  it('caps an undeclared (streamed) body', async () => {
    const big = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 100; i++) c.enqueue(new Uint8Array(1024));
        c.close();
      },
    });
    const r = await handle(
      new Request('https://cloud.test/v1/auth/select-organization', {
        method: 'POST',
        body: big,
        // @ts-expect-error: Node needs it for a stream body; Workers ignore it
        duplex: 'half',
      }),
      deps,
    );
    expect(r.status).toBe(413);
  });

  it('404 and 405', async () => {
    expect((await call('/nope')).status).toBe(404);
    expect((await call('/v1/orgs/personal')).status).toBe(405);
  });

  it('refuses a declared oversize body unread', async () => {
    const r = await call('/v1/orgs/personal', {
      method: 'POST',
      headers: { 'content-length': String(1024 * 1024) },
    });
    expect(r.status).toBe(413);
  });

  it('hides unexpected errors', async () => {
    const r = await handle(
      new Request('https://cloud.test/v1/orgs/personal', {
        method: 'POST',
        headers: { authorization: 'Bearer a.b.c' },
      }),
      () => ({
        workos,
        clientId: CLIENT,
        verify: async () => {
          throw new Error('secret detail');
        },
      }),
    );
    expect(r.status).toBe(500);
    expect(await r.text()).not.toContain('secret detail');
  });
});

describe('worker', () => {
  it('fails closed when not configured', async () => {
    const r = await worker.fetch(new Request('https://cloud.test/v1/health'), {
      WORKOS_API_KEY: '',
      WORKOS_CLIENT_ID: '',
    });
    expect(r.status).toBe(500);
    expect(await r.text()).toContain('cloud.config');
  });

  it('builds deps from env', () => {
    const d = depsFor({
      WORKOS_API_KEY: 'sk_test_x',
      WORKOS_CLIENT_ID: CLIENT,
    });
    expect(typeof d.verify).toBe('function');
    expect(remoteKeys(API, CLIENT)).toBe(remoteKeys(API, CLIENT));
  });
});
