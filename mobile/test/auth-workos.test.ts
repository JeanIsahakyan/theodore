import { describe, expect, it } from 'vitest';
import { AuthError } from '../src/auth/errors';
import {
  WorkosApi,
  cloudError,
  parseAuthResponse,
  type HttpFetch,
} from '../src/auth/workos';
import {
  API,
  CLIENT_ID,
  CLOUD,
  NOW_S,
  authBody,
  fakeFetch,
  form,
  makeKey,
} from './auth-helpers';

const key = makeKey();
const AUTH = `POST ${API}/user_management/authenticate`;
const JWKS = `GET ${API}/sso/jwks/${CLIENT_ID}`;
const jwksOk = () => ({
  status: 200,
  body: JSON.stringify({ keys: [key.jwk] }),
});

function api(fetch: HttpFetch, cloudUrl: string | null = CLOUD) {
  const warnings: string[] = [];
  const a = new WorkosApi(
    { apiBase: API, clientId: CLIENT_ID, cloudUrl },
    fetch,
    () => NOW_S * 1000,
    (m) => warnings.push(m),
  );
  return Object.assign(a, { warnings });
}

async function errorOf(p: Promise<unknown>): Promise<AuthError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AuthError) return e;
    throw e;
  }
  throw new Error('expected an error');
}

describe('token responses', () => {
  it('parses a session body', () => {
    const r = parseAuthResponse(authBody(key, { organization_id: 'org_1' }));
    expect(r).toMatchObject({
      userId: 'user_1',
      email: 'a@b.c',
      name: 'Ada L',
      organizationId: 'org_1',
      refreshToken: 'refresh_2',
    });
  });

  it('refuses bodies without user or tokens', () => {
    for (const body of ['', '[]', '{}', '{"user":{"id":"u","email":"e"}}']) {
      expect(() => parseAuthResponse(body)).toThrow(AuthError);
    }
  });
});

describe('code exchange', () => {
  it('sends the public-client form and validates the token', async () => {
    const f = fakeFetch({
      [AUTH]: () => ({ status: 200, body: authBody(key) }),
      [JWKS]: jwksOk,
    });
    const r = await api(f).exchangeCode('code_1', 'verifier_1');
    expect(r.kind).toBe('session');
    if (r.kind !== 'session') return;
    expect(r.session).toMatchObject({
      userId: 'user_1',
      expiresAt: (NOW_S + 300) * 1000,
      organizationId: null,
      role: null,
    });
    expect(form(f.calls[0].body)).toEqual({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code: 'code_1',
      code_verifier: 'verifier_1',
    });
    expect(f.calls[0].body).not.toContain('client_secret');
  });

  it('turns organization_selection_required into a choice', async () => {
    const f = fakeFetch({
      [AUTH]: () => ({
        status: 403,
        body: JSON.stringify({
          code: 'organization_selection_required',
          pending_authentication_token: 'pending_1',
          organizations: [{ id: 'org_a', name: 'A' }, { id: 'org_b' }],
        }),
      }),
    });
    expect(await api(f).exchangeCode('c', 'v')).toEqual({
      kind: 'select',
      selection: {
        pendingToken: 'pending_1',
        organizations: [
          { id: 'org_a', name: 'A' },
          { id: 'org_b', name: '' },
        ],
      },
    });
  });

  it('needs a pending token and organizations to choose from', async () => {
    const f = fakeFetch({
      [AUTH]: () => ({
        status: 403,
        body: JSON.stringify({ code: 'organization_selection_required' }),
      }),
    });
    const e = await errorOf(api(f).exchangeCode('c', 'v'));
    expect(e.kind).toBe('protocol');
  });

  it('maps provider answers like the desktop', async () => {
    const cases: [number, string, string][] = [
      [
        400,
        '{"error":"invalid_grant","error_description":"bad code"}',
        'rejected',
      ],
      [400, '<html>proxy</html>', 'network'],
      [404, '', 'network'],
      [500, '{"error":"x"}', 'network'],
      [429, '{"error":"x"}', 'network'],
    ];
    for (const [status, body, expected] of cases) {
      const f = fakeFetch({ [AUTH]: () => ({ status, body }) });
      const e = await errorOf(api(f).exchangeCode('c', 'v'));
      expect([status, e.kind]).toEqual([status, expected]);
    }
    const offline = fakeFetch({
      [AUTH]: () => new TypeError('Network request failed'),
    });
    expect((await errorOf(api(offline).exchangeCode('c', 'v'))).kind).toBe(
      'network',
    );
  });

  it('never echoes the pending token', async () => {
    const f = fakeFetch({
      [AUTH]: () => ({
        status: 403,
        body: JSON.stringify({
          error: 'organization_selection_required',
          pending_authentication_token: 'secret_pending',
          organizations: [],
        }),
      }),
    });
    const e = await errorOf(api(f).exchangeCode('c', 'v'));
    expect(e.message).not.toContain('secret_pending');
  });
});

describe('validation', () => {
  it('refuses a token signed by another key', async () => {
    const forger = makeKey(2048, key.jwk.kid);
    const f = fakeFetch({
      [AUTH]: () => ({ status: 200, body: authBody(forger) }),
      [JWKS]: jwksOk,
    });
    expect((await errorOf(api(f).exchangeCode('c', 'v'))).kind).toBe(
      'invalid_token',
    );
  });

  it('refuses a token for another user', async () => {
    const f = fakeFetch({
      [AUTH]: () => ({
        status: 200,
        body: authBody(key, { claims: { sub: 'user_2' } }),
      }),
      [JWKS]: jwksOk,
    });
    expect((await errorOf(api(f).exchangeCode('c', 'v'))).kind).toBe(
      'invalid_token',
    );
  });

  it('keeps the claim checks when the JWKS is unreachable (provider token)', async () => {
    const f = fakeFetch({
      [AUTH]: () => ({ status: 200, body: authBody(key) }),
      [JWKS]: () => new TypeError('CORS'),
    });
    const a = api(f);
    expect((await a.exchangeCode('c', 'v')).kind).toBe('session');
    expect(a.warnings.join()).toContain('JWKS unreachable');

    const expired = fakeFetch({
      [AUTH]: () => ({
        status: 200,
        body: authBody(key, { claims: { exp: NOW_S - 120 } }),
      }),
      [JWKS]: () => ({ status: 503, body: '' }),
    });
    expect((await errorOf(api(expired).exchangeCode('c', 'v'))).kind).toBe(
      'invalid_token',
    );
  });

  it('refetches the JWKS for an unknown kid', async () => {
    const next = makeKey(2048, 'rotated');
    let served = [key.jwk];
    let token = authBody(key);
    const f = fakeFetch({
      [AUTH]: () => ({ status: 200, body: token }),
      [JWKS]: () => ({ status: 200, body: JSON.stringify({ keys: served }) }),
    });
    const a = api(f);
    await a.exchangeCode('c', 'v');
    await a.exchangeCode('c', 'v');
    expect(f.calls.filter((c) => c.url.includes('/sso/jwks/'))).toHaveLength(1);
    served = [key.jwk, next.jwk];
    token = authBody(next);
    expect((await a.exchangeCode('c', 'v')).kind).toBe('session');
    expect(f.calls.filter((c) => c.url.includes('/sso/jwks/'))).toHaveLength(2);
  });
});

describe('refresh', () => {
  it('rotates, with organization_id only for a switch', async () => {
    const f = fakeFetch({
      [AUTH]: () => ({
        status: 200,
        body: authBody(key, {
          organization_id: 'org_1',
          claims: { org_id: 'org_1', role: 'admin' },
        }),
      }),
      [JWKS]: jwksOk,
    });
    const a = api(f);
    await a.refresh('refresh_1', null);
    expect(form(f.calls[0].body)).toEqual({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: 'refresh_1',
    });
    const r = await a.refresh('refresh_2', 'org_1');
    expect(form(f.calls.at(-1)!.body).organization_id).toBe('org_1');
    expect(r.kind === 'session' && r.session.role).toBe('admin');
  });
});

describe('cloud', () => {
  const SELECT = `POST ${CLOUD}/v1/auth/select-organization`;

  it("finishes an org selection by trading the cloud's refresh token with WorkOS", async () => {
    // The cloud's own access token isn't kept (or even checked): its refresh
    // token goes straight to WorkOS, whose answer is the session — so this
    // works on the web, where WorkOS's JWKS has no CORS.
    const fromCloud = authBody(key, {
      organization_id: 'org_b',
      claims: { org_id: 'org_b' },
      refresh_token: 'rt_from_cloud',
    });
    const fromWorkos = authBody(key, {
      organization_id: 'org_b',
      claims: { org_id: 'org_b' },
      refresh_token: 'rt_workos',
    });
    const f = fakeFetch({
      [SELECT]: () => ({ status: 200, body: fromCloud }),
      [AUTH]: () => ({ status: 200, body: fromWorkos }),
      [JWKS]: () => new TypeError('no CORS'),
    });
    const s = await api(f).selectOrganization('pending_1', 'org_b');
    expect(s.organizationId).toBe('org_b');
    expect(s.refreshToken).toBe('rt_workos');
    expect(JSON.parse(f.calls[0].body!)).toEqual({
      pending_authentication_token: 'pending_1',
      organization_id: 'org_b',
    });
    const refresh = f.calls.find((c) =>
      c.url.endsWith('/user_management/authenticate'),
    );
    expect(form(refresh!.body!)).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'rt_from_cloud',
      organization_id: 'org_b',
    });
  });

  it("refuses a cloud selection WorkOS won't refresh (a forged token)", async () => {
    const f = fakeFetch({
      [SELECT]: () => ({
        status: 200,
        body: authBody(key, { organization_id: 'org_b' }),
      }),
      [AUTH]: () => ({
        status: 400,
        body: '{"error":"invalid_grant","error_description":"bad refresh token"}',
      }),
      [JWKS]: jwksOk,
    });
    expect((await errorOf(api(f).selectOrganization('p', 'org_b'))).kind).toBe(
      'rejected',
    );
  });

  it('refuses a selected session in another org', async () => {
    const f = fakeFetch({
      [SELECT]: () => ({
        status: 200,
        body: authBody(key, { organization_id: 'org_b' }),
      }),
      [AUTH]: () => ({
        status: 200,
        body: authBody(key, {
          organization_id: 'org_a',
          claims: { org_id: 'org_a' },
        }),
      }),
      [JWKS]: jwksOk,
    });
    expect((await errorOf(api(f).selectOrganization('p', 'org_b'))).kind).toBe(
      'invalid_token',
    );
  });

  it('ensures the personal org and lists orgs with the bearer token', async () => {
    const f = fakeFetch({
      [`POST ${CLOUD}/v1/orgs/personal`]: () => ({
        status: 200,
        body: '{"organization_id":"org_p","created":true}',
      }),
      [`GET ${CLOUD}/v1/orgs`]: () => ({
        status: 200,
        body: JSON.stringify({
          organizations: [
            { id: 'org_p', name: 'Me', role: 'admin', personal: true },
            { id: 'org_t', name: 'Team', role: '' },
          ],
        }),
      }),
    });
    const a = api(f);
    expect(await a.ensurePersonalOrganization('tok')).toBe('org_p');
    expect(await a.organizations('tok')).toEqual([
      { id: 'org_p', name: 'Me', role: 'admin', personal: true },
      { id: 'org_t', name: 'Team', role: null, personal: false },
    ]);
    expect(f.calls.every((c) => c.headers.authorization === 'Bearer tok')).toBe(
      true,
    );
  });

  it('maps cloud errors', () => {
    const e = (status: number, body: string) =>
      cloudError(status, 'v1/x', body).kind;
    expect(e(400, '{"error":{"code":"cloud.rejected","message":"m"}}')).toBe(
      'rejected',
    );
    expect(e(409, '{"error":{"code":"cloud.membership_inactive"}}')).toBe(
      'protocol',
    );
    expect(
      e(401, '{"error":{"code":"cloud.unauthorized","message":"m"}}'),
    ).toBe('protocol');
    expect(e(403, '<html>')).toBe('network');
  });

  it('is a config error without a cloud URL', async () => {
    const e = await errorOf(api(fakeFetch({}), null).organizations('tok'));
    expect(e.kind).toBe('config');
  });
});

describe('logout', () => {
  it('is a GET with the session id; a redirect is success', async () => {
    const f = fakeFetch({
      [`GET ${API}/user_management/sessions/logout`]: () => ({
        status: 302,
        body: '',
      }),
    });
    await api(f).logout('session_1');
    expect(f.calls[0].url).toContain('session_id=session_1');
  });
});
