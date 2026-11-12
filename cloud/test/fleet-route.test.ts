import { describe, expect, it } from 'vitest';
import { verifyAccessToken } from '../src/auth';
import { CALLER_HEADER, readCaller } from '../src/fleet/org-hub';
import { handle, type Deps } from '../src/index';
import { FakeWorkos } from './fake-workos';
import { API, CLIENT, signer } from './keys';

describe('GET /v1/fleet/ws', async () => {
  const { keys, sign } = await signer();
  const seen: { org: string; request: Request }[] = [];
  const deps = (withHub = true): Deps => ({
    workos: new FakeWorkos(),
    clientId: CLIENT,
    verify: (t) =>
      verifyAccessToken(t, { apiBase: API, clientId: CLIENT, keys }),
    hub: withHub
      ? (org) => ({
          fetch: async (request) => {
            seen.push({ org, request });
            return new Response('upgraded', { status: 200 });
          },
        })
      : undefined,
  });
  const call = (headers: Record<string, string>, withHub = true) =>
    handle(new Request('https://cloud.test/v1/fleet/ws', { headers }), () =>
      deps(withHub),
    );
  const code = async (r: Response) =>
    ((await r.json()) as { error: { code: string } }).error.code;
  const ws = { upgrade: 'websocket' };

  it('wants a WebSocket upgrade', async () => {
    const r = await call({});
    expect(r.status).toBe(426);
    expect(await code(r)).toBe('fleet.upgrade_required');
  });

  it('refuses no or a bad token with 401 fleet.unauthorized', async () => {
    expect(await code(await call(ws))).toBe('fleet.unauthorized');
    const forged = await (await signer()).sign({ sub: 'user_1', org_id: 'o' });
    const r = await call({ ...ws, authorization: `Bearer ${forged}` });
    expect(r.status).toBe(401);
  });

  it('refuses a token without an org with 403 fleet.no_org', async () => {
    const t = await sign({ sub: 'user_1' });
    const r = await call({ ...ws, authorization: `Bearer ${t}` });
    expect(r.status).toBe(403);
    expect(await code(r)).toBe('fleet.no_org');
  });

  it('forwards to the org’s hub with the verified caller only', async () => {
    const exp = Math.floor(Date.now() / 1000) + 300;
    const t = await sign(
      { sub: 'user_1', org_id: 'org_7', sid: 's_1' },
      { exp },
    );
    const r = await call({
      ...ws,
      authorization: `Bearer ${t}`,
      [CALLER_HEADER]: JSON.stringify({
        userId: 'admin',
        orgId: 'org_7',
        expMs: 9e15,
      }),
    });
    expect(await r.text()).toBe('upgraded');
    const { org, request } = seen.at(-1)!;
    expect(org).toBe('org_7');
    expect(request.headers.get('authorization')).toBeNull();
    expect(request.headers.get('upgrade')).toBe('websocket');
    expect(readCaller(request.headers.get(CALLER_HEADER))).toEqual({
      userId: 'user_1',
      orgId: 'org_7',
      sessionId: 's_1',
      expMs: exp * 1000,
    });
  });

  it('answers cloud.config without the hub binding', async () => {
    const t = await sign({ sub: 'user_1', org_id: 'org_7' });
    const r = await call({ ...ws, authorization: `Bearer ${t}` }, false);
    expect(r.status).toBe(500);
    expect(await code(r)).toBe('cloud.config');
  });
});

describe('readCaller', () => {
  it('reads only a well-formed caller', () => {
    expect(readCaller(null)).toBeNull();
    expect(readCaller('{')).toBeNull();
    expect(readCaller('{"userId":"u"}')).toBeNull();
  });
});
