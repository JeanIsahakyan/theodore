import { describe, expect, it } from 'vitest';
import { verifyAccessToken } from '../src/auth';
import { CALLER_HEADER, readCaller } from '../src/fleet/org-hub';
import { answerRequest } from '../src/fleet/route';
import { handle, parseOrigins, type Deps } from '../src/index';
import { FakeWorkos } from './fake-workos';
import { Harness } from './fleet-harness';
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

  it('answers a JWKS outage with 503, which the device redials', async () => {
    const t = await sign({ sub: 'user_1', org_id: 'org_7' });
    const r = await handle(
      new Request('https://cloud.test/v1/fleet/ws', {
        headers: { ...ws, authorization: `Bearer ${t}` },
      }),
      () => ({
        ...deps(),
        verify: (tok) =>
          verifyAccessToken(tok, {
            apiBase: API,
            clientId: CLIENT,
            keys: async () => {
              throw new TypeError('fetch failed');
            },
          }),
      }),
    );
    expect(r.status).toBe(503);
    expect(await code(r)).toBe('cloud.jwks_unavailable');
  });

  it('answers cloud.config without the hub binding', async () => {
    const t = await sign({ sub: 'user_1', org_id: 'org_7' });
    const r = await call({ ...ws, authorization: `Bearer ${t}` }, false);
    expect(r.status).toBe(500);
    expect(await code(r)).toBe('cloud.config');
  });
});

const WEB = 'https://theodore-web-staging.prd-instance.workers.dev';

describe('browser sockets: the token as a subprotocol', async () => {
  const { keys, sign } = await signer();
  const seen: Request[] = [];
  const deps = (): Deps => ({
    workos: new FakeWorkos(),
    clientId: CLIENT,
    verify: (t) =>
      verifyAccessToken(t, { apiBase: API, clientId: CLIENT, keys }),
    hub: () => ({
      fetch: async (request) => {
        seen.push(request);
        return new Response('upgraded');
      },
    }),
  });
  const call = (headers: Record<string, string>) =>
    handle(new Request('https://cloud.test/v1/fleet/ws', { headers }), deps, [
      WEB,
    ]);
  const token = () => sign({ sub: 'user_1', org_id: 'org_7' });

  it('takes `bearer.<token>` from the web app’s origin', async () => {
    const t = await token();
    const r = await call({
      upgrade: 'websocket',
      origin: WEB,
      'sec-websocket-protocol': `bearer, bearer.${t}`,
    });
    expect(await r.text()).toBe('upgraded');
    const forwarded = seen.at(-1)!;
    // The token stays in the Worker; the hub only echoes `bearer`.
    expect(forwarded.headers.get('sec-websocket-protocol')).toBe('bearer');
    expect([...forwarded.headers.values()].join(' ')).not.toContain(t);
    expect(readCaller(forwarded.headers.get(CALLER_HEADER))?.orgId).toBe(
      'org_7',
    );
  });

  it('echoes the token entry when the browser offered only that', async () => {
    // The 101 must pick an offered protocol, or the browser drops it.
    const t = await token();
    const r = await call({
      upgrade: 'websocket',
      origin: WEB,
      'sec-websocket-protocol': `bearer.${t}`,
    });
    expect(await r.text()).toBe('upgraded');
    expect(seen.at(-1)!.headers.get('sec-websocket-protocol')).toBe(
      `bearer.${t}`,
    );
  });

  it('refuses it from any other origin', async () => {
    const t = await token();
    const cases: Record<string, string>[] = [
      {
        origin: 'https://evil.test',
        'sec-websocket-protocol': `bearer, bearer.${t}`,
      },
      { 'sec-websocket-protocol': `bearer, bearer.${t}` },
      { origin: WEB, 'sec-websocket-protocol': 'bearer, bearer.' },
    ];
    for (const headers of cases) {
      const r = await call({ upgrade: 'websocket', ...headers });
      expect(r.status).toBe(401);
    }
  });

  it('keeps the Authorization header path as it was', async () => {
    const t = await token();
    const r = await call({
      upgrade: 'websocket',
      authorization: `Bearer ${t}`,
      'sec-websocket-protocol': 'something',
    });
    expect(await r.text()).toBe('upgraded');
    expect(seen.at(-1)!.headers.get('sec-websocket-protocol')).toBeNull();
  });
});

describe('POST /v1/fleet/request', async () => {
  const { keys, sign } = await signer();
  const seen: { org: string; request: Request }[] = [];
  const limited: string[] = [];
  let allow = true;
  const deps = (): Deps => ({
    workos: new FakeWorkos(),
    clientId: CLIENT,
    verify: (t) =>
      verifyAccessToken(t, { apiBase: API, clientId: CLIENT, keys }),
    hub: (org) => ({
      fetch: async (request) => {
        seen.push({ org, request });
        return Response.json({ accepted: true, req_id: 'r1' }, { status: 202 });
      },
    }),
    limit: async (bucket, key) => {
      limited.push(`${bucket}:${key}`);
      return allow;
    },
  });
  const envelope = { device_id: 'dev_1', body: '{}', signature: 'c2ln' };
  const call = (headers: Record<string, string>, body: unknown) =>
    handle(
      new Request('https://cloud.test/v1/fleet/request', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }),
      deps,
    );
  const code = async (r: Response) =>
    ((await r.json()) as { error: { code: string } }).error.code;

  it('wants a token with an org', async () => {
    const r = await call({}, { device_id: 'dev_1', envelope });
    expect(r.status).toBe(401);
    expect(await code(r)).toBe('fleet.unauthorized');
    const t = await sign({ sub: 'user_1' });
    const n = await call(
      { authorization: `Bearer ${t}` },
      { device_id: 'dev_1', envelope },
    );
    expect(n.status).toBe(403);
    expect(await code(n)).toBe('fleet.no_org');
  });

  it('wants {device_id, envelope}', async () => {
    const t = await sign({ sub: 'user_1', org_id: 'org_7' });
    const r = await call({ authorization: `Bearer ${t}` }, { envelope });
    expect(r.status).toBe(400);
    expect(await code(r)).toBe('cloud.bad_request');
  });

  it('forwards the verified caller and the request to the org’s hub', async () => {
    const t = await sign({ sub: 'user_1', org_id: 'org_7' });
    const r = await call(
      { authorization: `Bearer ${t}`, [CALLER_HEADER]: '{"userId":"admin"}' },
      { device_id: 'dev_1', envelope, extra: 'dropped' },
    );
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ accepted: true, req_id: 'r1' });
    const { org, request } = seen.at(-1)!;
    expect(org).toBe('org_7');
    expect(new URL(request.url).pathname).toBe('/v1/fleet/request');
    expect(request.headers.get('authorization')).toBeNull();
    expect(readCaller(request.headers.get(CALLER_HEADER))?.userId).toBe(
      'user_1',
    );
    expect(await request.json()).toEqual({ device_id: 'dev_1', envelope });
  });

  it('is rate-limited per user', async () => {
    allow = false;
    limited.length = 0;
    const t = await sign({ sub: 'user_rl', org_id: 'org_7' });
    const r = await call(
      { authorization: `Bearer ${t}` },
      { device_id: 'dev_1', envelope },
    );
    allow = true;
    expect(r.status).toBe(429);
    expect(limited).toEqual(['user:user_rl']);
  });
});

describe('the hub’s side of POST /v1/fleet/request', () => {
  const caller = { userId: 'user_1', orgId: 'org_1', expMs: 9e15 };
  const post = (body: unknown) =>
    new Request('https://hub/v1/fleet/request', {
      method: 'POST',
      body: JSON.stringify(body),
    });

  it('answers 202 when routed, a non-2xx with the code when refused', async () => {
    const h = new Harness();
    const mac = await h.device('user_1', 'mac');
    const phone = await h.phone();
    await mac.connect();
    await phone.connect();
    const envelope = await phone.envelope(mac.id!, { op: 'stop', space: 's' });
    const ok = await answerRequest(
      h.hub,
      caller,
      post({ device_id: phone.id, envelope }),
    );
    expect(ok.status).toBe(202);
    expect(await ok.json()).toMatchObject({ accepted: true });
    const no = await answerRequest(
      h.hub,
      { ...caller, userId: 'user_2' },
      post({ device_id: phone.id, envelope }),
    );
    expect(no.status).toBe(409);
    expect(await no.json()).toMatchObject({
      accepted: false,
      refused: { code: 'fleet.not_yours' },
    });
    const junk = await answerRequest(
      h.hub,
      caller,
      post({ device_id: phone.id, envelope: { ...envelope, body: '{}' } }),
    );
    expect(junk.status).toBe(400);
    expect(await junk.json()).toMatchObject({
      refused: { code: 'fleet.bad_message' },
    });
    const bad = await answerRequest(h.hub, caller, post({ nope: 1 }));
    expect(bad.status).toBe(400);
  });
});

describe('CORS for the web app', async () => {
  const { keys, sign } = await signer();
  const deps = (): Deps => ({
    workos: new FakeWorkos(),
    clientId: CLIENT,
    verify: (t) =>
      verifyAccessToken(t, { apiBase: API, clientId: CLIENT, keys }),
  });
  const call = (path: string, init: RequestInit) =>
    handle(new Request(`https://cloud.test${path}`, init), deps, [WEB]);

  it('answers a preflight from the web origin, on its routes only', async () => {
    for (const path of [
      '/v1/orgs',
      '/v1/orgs/personal',
      '/v1/auth/select-organization',
      '/v1/fleet/request',
    ]) {
      const r = await call(path, {
        method: 'OPTIONS',
        headers: {
          origin: WEB,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization, content-type',
        },
      });
      expect(r.status).toBe(204);
      expect(r.headers.get('access-control-allow-origin')).toBe(WEB);
      expect(r.headers.get('access-control-allow-headers')).toBe(
        'Authorization, Content-Type',
      );
      expect(r.headers.get('access-control-allow-credentials')).toBeNull();
    }
    const other = await call('/v1/orgs', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.test' },
    });
    expect(other.status).toBe(204);
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    const health = await call('/v1/health', {
      method: 'OPTIONS',
      headers: { origin: WEB },
    });
    expect(health.status).toBe(405);
  });

  it('lets the web origin read answers and errors', async () => {
    const t = await sign({ sub: 'user_9' });
    const ok = await call('/v1/orgs', {
      headers: { origin: WEB, authorization: `Bearer ${t}` },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe(WEB);
    expect(ok.headers.get('vary')).toBe('Origin');
    const err = await call('/v1/orgs', { headers: { origin: WEB } });
    expect(err.status).toBe(401);
    expect(err.headers.get('access-control-allow-origin')).toBe(WEB);
    const elsewhere = await call('/v1/orgs', {
      headers: { origin: 'https://evil.test', authorization: `Bearer ${t}` },
    });
    expect(elsewhere.headers.get('access-control-allow-origin')).toBeNull();
    const health = await call('/v1/health', { headers: { origin: WEB } });
    expect(health.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('reads WEB_ORIGINS as a list', () => {
    expect(parseOrigins(undefined)).toEqual([]);
    expect(parseOrigins(' https://a.dev/ , ,https://b.dev')).toEqual([
      'https://a.dev',
      'https://b.dev',
    ]);
  });

  it('allows each listed origin: the new domain and the old workers.dev URL', async () => {
    const NEW = 'https://app-staging.theodore.cloud';
    const t = await sign({ sub: 'user_9' });
    for (const origin of [NEW, WEB]) {
      const r = await handle(
        new Request('https://api-staging.theodore.cloud/v1/orgs', {
          headers: { origin, authorization: `Bearer ${t}` },
        }),
        deps,
        parseOrigins(`${NEW},${WEB}`),
      );
      expect(r.status).toBe(200);
      expect(r.headers.get('access-control-allow-origin')).toBe(origin);
    }
  });
});

describe('readCaller', () => {
  it('reads only a well-formed caller', () => {
    expect(readCaller(null)).toBeNull();
    expect(readCaller('{')).toBeNull();
    expect(readCaller('{"userId":"u"}')).toBeNull();
  });
});
