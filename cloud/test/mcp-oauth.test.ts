// OAuth for /mcp end to end, no network: metadata, dynamic client
// registration, consent, AuthKit sign-in (fake WorkOS), PKCE, refresh, and
// tool calls reaching the org's hub (the real OrgHub over node:sqlite).
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { Loose } from './loose';
import type { VerifiedToken } from '../src/fleet/hub';
import { OrgHub } from '../src/fleet/org-hub';
import { CloudError } from '../src/errors';
import worker, { type Deps } from '../src/index';
import { mcpFetch } from '../src/mcp/oauth';
import { WorkosError, type Authentication } from '../src/workos';
import { FakeWorkos } from './fake-workos';
import { MCP_TEST_SECRET } from './fleet-harness';

const ORIGIN = 'https://cloud.test';
const API = 'https://api.workos.test';
const REDIRECT = 'http://localhost:33418/callback';

/** Workers KV, in memory (expiry ignored). */
class FakeKv {
  m = new Map<string, string>();
  async get(key: string, o?: unknown) {
    const v = this.m.get(key);
    if (v === undefined) return null;
    const type = typeof o === 'string' ? o : (o as { type?: string })?.type;
    return type === 'json' ? JSON.parse(v) : v;
  }
  async put(key: string, value: string) {
    this.m.set(key, value);
  }
  async delete(key: string) {
    this.m.delete(key);
  }
  async list(o: { prefix?: string } = {}) {
    const keys = [...this.m.keys()]
      .filter((k) => k.startsWith(o.prefix ?? ''))
      .sort()
      .map((name) => ({ name }));
    return { keys, list_complete: true, cacheStatus: null };
  }
}

/** A DO state for OrgHub outside workerd. */
function doState(db: DatabaseSync): DurableObjectState {
  return {
    storage: {
      sql: {
        exec: (q: string, ...b: unknown[]) => ({
          toArray: () => db.prepare(q).all(...b),
        }),
      },
      getAlarm: async () => null,
      setAlarm: async () => {},
    },
    getWebSockets: () => [],
    acceptWebSocket: () => {},
    waitUntil: () => {},
  } as unknown as DurableObjectState;
}

const ctx = () =>
  ({
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
  }) as unknown as ExecutionContext;

class Jar {
  m = new Map<string, string>();
  take(r: Response) {
    for (const c of r.headers.getSetCookie()) {
      const [nv = ''] = c.split(';');
      const at = nv.indexOf('=');
      const name = nv.slice(0, at);
      const value = nv.slice(at + 1);
      if (/max-age=0/i.test(c) || value === '') this.m.delete(name);
      else this.m.set(name, value);
    }
    return r;
  }
  get header() {
    return [...this.m].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
    ),
  );
  return { verifier, challenge };
}

function setup() {
  const kv = new FakeKv();
  const workos = new FakeWorkos();
  const tokens = new Map<string, VerifiedToken & { permissions: string[] }>();
  const hubs = new Map<string, OrgHub>();
  const deps: Deps = {
    workos,
    clientId: 'client_01APP',
    apiBase: API,
    verify: async (t) => {
      const v = tokens.get(t);
      if (!v) throw new CloudError(401, 'cloud.unauthorized', 'bad token');
      return v;
    },
    hub: (org) => {
      let h = hubs.get(org);
      if (!h) {
        h = new OrgHub(doState(new DatabaseSync(':memory:')), {
          WORKOS_CLIENT_ID: 'client_01APP',
          WORKOS_API_BASE: API,
          MCP_KEY_WRAP: MCP_TEST_SECRET,
        });
        hubs.set(org, h);
      }
      return h;
    },
  };
  const env = {
    OAUTH_KV: kv as unknown as KVNamespace,
    MCP_KEY_WRAP: MCP_TEST_SECRET,
  };
  const call = (path: string, init: RequestInit = {}) =>
    mcpFetch(new Request(`${ORIGIN}${path}`, init), env, ctx(), () => deps);
  const session = (
    access: string,
    refresh: string,
    org: string | null,
  ): Authentication => {
    tokens.set(access, {
      userId: 'user_1',
      organizationId: org ?? undefined,
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      permissions: [],
    });
    return {
      user: { id: 'user_1', email: 'u@example.test' },
      organization_id: org,
      access_token: access,
      refresh_token: refresh,
    };
  };
  return { kv, workos, tokens, hubs, call, session };
}

type S = ReturnType<typeof setup>;

async function register(s: S): Promise<string> {
  const r = await s.call('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Claude Code',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { client_id: string }).client_id;
}

/** Consent ─▶ Allow: where the browser goes next (AuthKit), with its jar. */
async function consentAndAllow(s: S, clientId: string, challenge: string) {
  const jar = new Jar();
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'client-state',
    scope: 'fleet',
    resource: `${ORIGIN}/mcp`,
  });
  const page = jar.take(await s.call(`/oauth/authorize?${q}`));
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('Claude Code');
  expect(html).toContain('localhost');
  expect(page.headers.get('x-frame-options')).toBe('DENY');
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1]!;
  const allowed = jar.take(
    await s.call('/oauth/authorize', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: jar.header,
      },
      body: new URLSearchParams({ handle, decision: 'allow' }).toString(),
    }),
  );
  expect(allowed.status).toBe(302);
  const authkit = new URL(allowed.headers.get('location')!);
  expect(authkit.origin + authkit.pathname).toBe(
    `${API}/user_management/authorize`,
  );
  expect(authkit.searchParams.get('provider')).toBe('authkit');
  expect(authkit.searchParams.get('redirect_uri')).toBe(
    `${ORIGIN}/oauth/callback`,
  );
  return { jar, state: authkit.searchParams.get('state')! };
}

/** The client's code from a redirect back to it. */
function clientCode(r: Response): string {
  expect(r.status).toBe(302);
  const back = new URL(r.headers.get('location')!);
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
  expect(back.searchParams.get('state')).toBe('client-state');
  return back.searchParams.get('code')!;
}

async function token(s: S, form: Record<string, string>) {
  return s.call('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
}

/** Full sign-in for `code` (AuthKit's): the client's tokens. */
async function signIn(s: S, wcode: string) {
  const clientId = await register(s);
  const { verifier, challenge } = await pkce();
  const { jar, state } = await consentAndAllow(s, clientId, challenge);
  const cb = await s.call(`/oauth/callback?code=${wcode}&state=${state}`, {
    headers: { cookie: jar.header },
  });
  const code = clientCode(cb);
  const t = await token(s, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
  });
  expect(t.status).toBe(200);
  const body = (await t.json()) as {
    access_token: string;
    refresh_token: string;
    token_type: string;
  };
  return { ...body, clientId };
}

const rpc = (s: S, access: string, body: unknown) =>
  s.call('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${access}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify(body),
  });

describe('discovery', () => {
  it('challenges /mcp and publishes both metadata documents', async () => {
    const s = setup();
    const r = await s.call('/mcp', { method: 'POST', body: '{}' });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
    const pr = (await (
      await s.call('/.well-known/oauth-protected-resource/mcp')
    ).json()) as Record<string, unknown>;
    expect(pr.resource).toBe(`${ORIGIN}/mcp`);
    expect(pr.authorization_servers).toEqual([ORIGIN]);
    expect(pr.scopes_supported).toEqual(['fleet']);
    const as = (await (
      await s.call('/.well-known/oauth-authorization-server')
    ).json()) as Record<string, unknown>;
    expect(as.issuer).toBe(ORIGIN);
    expect(as.authorization_endpoint).toBe(`${ORIGIN}/oauth/authorize`);
    expect(as.token_endpoint).toBe(`${ORIGIN}/oauth/token`);
    expect(as.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
  });

  it('is off without its bindings', async () => {
    const r = await worker.fetch(
      new Request(`${ORIGIN}/.well-known/oauth-authorization-server`),
      { WORKOS_API_KEY: 'k', WORKOS_CLIENT_ID: 'c' },
      ctx(),
    );
    expect(r.status).toBe(404);
    const h = await worker.fetch(
      new Request(`${ORIGIN}/v1/health`),
      { WORKOS_API_KEY: 'k', WORKOS_CLIENT_ID: 'c' },
      ctx(),
    );
    expect(h.status).toBe(200);
  });
});

describe('sign-in', () => {
  it('registers, consents, signs in with AuthKit, exchanges with PKCE', async () => {
    const s = setup();
    s.workos.codes.set('wcode', s.session('at1', 'rt1', 'org_1'));
    const t = await signIn(s, 'wcode');
    expect(t.token_type.toLowerCase()).toBe('bearer');
    expect(s.workos.calls).toContain('authenticateWithCode');
    // The MCP device was made at sign-in, in the org's hub.
    expect(s.hubs.has('org_1')).toBe(true);

    const init = (await (
      await rpc(s, t.access_token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {} },
      })
    ).json()) as Loose;
    expect(init.result.serverInfo.name).toBe('theodore');
    const status = (await (
      await rpc(s, t.access_token, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'theodore_status', arguments: {} },
      })
    ).json()) as Loose;
    const v = JSON.parse(String(status.result.content[0]!.text)) as Loose;
    expect(v.organization).toBe('org_1');
    expect(v.device.id).toMatch(/^dev_/);
    expect(v.device.fingerprint).toMatch(/^([0-9a-f]{4} ){7}[0-9a-f]{4}$/);
  });

  it('refuses a wrong PKCE verifier and a code used twice', async () => {
    const s = setup();
    s.workos.codes.set('wcode', s.session('at1', 'rt1', 'org_1'));
    const clientId = await register(s);
    const { verifier, challenge } = await pkce();
    const { jar, state } = await consentAndAllow(s, clientId, challenge);
    const code = clientCode(
      await s.call(`/oauth/callback?code=wcode&state=${state}`, {
        headers: { cookie: jar.header },
      }),
    );
    const form = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
    };
    const bad = await token(s, { ...form, code_verifier: `${verifier}x` });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe(
      'invalid_grant',
    );
  });

  it('binds the AuthKit state to the browser that consented', async () => {
    const s = setup();
    s.workos.codes.set('wcode', s.session('at1', 'rt1', 'org_1'));
    const clientId = await register(s);
    const { challenge } = await pkce();
    const { state } = await consentAndAllow(s, clientId, challenge);
    const r = await s.call(`/oauth/callback?code=wcode&state=${state}`);
    expect(r.status).toBe(400);
    expect(s.workos.calls).not.toContain('authenticateWithCode');
  });

  it('lets a user in 2+ orgs pick one', async () => {
    const s = setup();
    s.workos.codes.set(
      'wcode',
      new WorkosError(403, 'organization_selection_required', 'pick', {
        code: 'organization_selection_required',
        pending_authentication_token: 'pend',
        organizations: [
          { id: 'org_2', name: 'Team <b>' },
          { id: 'org_3', name: 'Other' },
        ],
      }),
    );
    s.session('at', 'rt', 'org_2');
    const clientId = await register(s);
    const { verifier, challenge } = await pkce();
    const { jar, state } = await consentAndAllow(s, clientId, challenge);
    const picker = jar.take(
      await s.call(`/oauth/callback?code=wcode&state=${state}`, {
        headers: { cookie: jar.header },
      }),
    );
    const html = await picker.text();
    expect(html).toContain('Team &#60;b&#62;');
    const action = /action="([^"]+)"/.exec(html)![1]!.replace(/&#38;/g, '&');
    const done = await s.call(action, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: jar.header,
      },
      body: new URLSearchParams({ organization_id: 'org_2' }).toString(),
    });
    const code = clientCode(done);
    expect(s.workos.selections).toEqual([
      { clientId: 'client_01APP', pending: 'pend', org: 'org_2' },
    ]);
    const t = await token(s, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    });
    expect(t.status).toBe(200);
    expect(s.hubs.has('org_2')).toBe(true);
  });

  it('gives a user with no org their personal one', async () => {
    const s = setup();
    s.workos.codes.set('wcode', s.session('at0', 'rt0', null));
    s.workos.refreshes.set('rt0', (org) =>
      s.session('atp', 'rtp', org ?? null),
    );
    await signIn(s, 'wcode');
    const personal = s.workos.orgs[0]!;
    expect(personal.external_id).toBe('personal:user_1');
    expect(s.workos.calls).toContain(`refreshSession ${personal.id}`);
    expect(s.hubs.has(personal.id)).toBe(true);
  });

  it('refreshes through WorkOS, and ends when WorkOS does', async () => {
    const s = setup();
    s.workos.codes.set('wcode', s.session('at1', 'rt1', 'org_1'));
    s.workos.refreshes.set('rt1', (org) =>
      org === 'org_1'
        ? s.session('at2', 'rt2', 'org_1')
        : new WorkosError(400, 'invalid_grant', 'no'),
    );
    const t = await signIn(s, 'wcode');
    const r = await token(s, {
      grant_type: 'refresh_token',
      refresh_token: t.refresh_token,
      client_id: t.clientId,
    });
    expect(r.status).toBe(200);
    const next = (await r.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(s.workos.calls).toContain('refreshSession org_1');
    const ping = await rpc(s, next.access_token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'ping',
    });
    expect(ping.status).toBe(200);
    // rt2 is unknown to the fake: WorkOS says the session is gone.
    const ended = await token(s, {
      grant_type: 'refresh_token',
      refresh_token: next.refresh_token,
      client_id: t.clientId,
    });
    expect(ended.status).toBe(400);
    expect(((await ended.json()) as { error: string }).error).toBe(
      'invalid_grant',
    );
  });

  it('refuses /mcp from a browser origin it doesn’t know', async () => {
    const s = setup();
    s.workos.codes.set('wcode', s.session('at1', 'rt1', 'org_1'));
    const t = await signIn(s, 'wcode');
    const r = await s.call('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${t.access_token}`,
        origin: 'https://evil.test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(r.status).toBe(403);
  });
});
