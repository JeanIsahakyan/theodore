/**
 * OAuth 2.1 for the MCP endpoint (the MCP authorization spec), with
 * Cloudflare's `@cloudflare/workers-oauth-provider` as the authorization
 * server and WorkOS AuthKit as the sign-in behind it.
 *
 * ```text
 * client ─POST /mcp─▶ 401 WWW-Authenticate: resource_metadata=…
 *   ─▶ GET /.well-known/oauth-protected-resource/mcp ─▶ authorization server
 *   ─▶ GET /.well-known/oauth-authorization-server
 *   ─▶ POST /oauth/register (dynamic client registration)
 *   ─▶ browser: GET /oauth/authorize (PKCE S256) ─▶ consent page ─▶ Allow
 *        ─▶ AuthKit sign-in (state bound to this browser)
 *        ─▶ GET /oauth/callback?code ─▶ WorkOS code exchange (API key)
 *           2+ orgs ─▶ pick one (/oauth/org) ─▶ organization-selection grant
 *           no org  ─▶ the personal org, then a refresh into it
 *        ─▶ grant {userId, orgId, WorkOS refresh token (encrypted)}
 *        ─▶ the MCP device made ─▶ back to the client with a code
 *   ─▶ POST /oauth/token (code + verifier) ─▶ access + refresh token
 *   refresh ─▶ WorkOS refresh into the same org; refused ─▶ grant revoked
 * POST /mcp + Bearer ─▶ scope `fleet` ─▶ Origin ─▶ RL_USER ─▶ src/mcp/rpc.ts
 * ```
 *
 * State (clients, grants, tokens, consent and upstream transactions) is
 * the library's, in the `OAUTH_KV` namespace: tokens hashed, props
 * encrypted with keys only the token holder unwraps. MCP is off (404)
 * unless both `OAUTH_KV` and `MCP_KEY_WRAP` are bound.
 */
import {
  AuthorizationError,
  authorizationErrorRedirect,
  GrantType,
  insufficientScope,
  OAuthError,
  OAuthProvider,
  type AuthRequest,
  type OAuthHelpers,
  type OAuthResourceAuth,
} from '@cloudflare/workers-oauth-provider';
import type { Caller } from '../auth';
import { CloudError, errorResponse } from '../errors';
import type { Deps } from '../index';
import { ensurePersonalOrganization } from '../orgs';
import {
  authkitAuthorizeUrl,
  WorkosError,
  type Authentication,
} from '../workos';
import { handleRpc } from './rpc';
import { callInHub, enableInHub, type McpGrant } from './route';

export const SCOPE = 'fleet';
export const MCP_PATH = '/mcp';
export const AUTHORIZE_PATH = '/oauth/authorize';
export const TOKEN_PATH = '/oauth/token';
export const REGISTER_PATH = '/oauth/register';
export const CALLBACK_PATH = '/oauth/callback';
export const ORG_PATH = '/oauth/org';

/** Access tokens live an hour; a refresh asks WorkOS again each time. */
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 24 * 3600;

/** Browser origins that may call `/mcp` (a request with none is fine). */
export const DEFAULT_MCP_ORIGINS = ['https://claude.ai', 'https://claude.com'];

/** The Worker's bindings MCP needs. */
export interface McpBindings {
  /** The OAuth provider's storage; absent: MCP is off. */
  OAUTH_KV?: KVNamespace;
  /** Wraps the MCP devices' keys (and is checked to be there). */
  MCP_KEY_WRAP?: string;
  /** Extra browser origins allowed on `/mcp`, comma-separated. */
  MCP_ORIGINS?: string;
}

/** What the provider's handlers get as `env`. */
interface ProviderEnv {
  OAUTH_KV: KVNamespace;
  MCP_DEPS: Deps;
  MCP_ORIGINS: string[];
  OAUTH_PROVIDER?: OAuthHelpers;
}

/** What a grant carries (encrypted at rest by the library). */
interface Props extends McpGrant {
  /** WorkOS's refresh token for this grant's session. */
  refreshToken: string;
}

/** Paths the provider answers (the rest is src/index.ts's). */
export function isMcpPath(path: string): boolean {
  return (
    path === MCP_PATH ||
    path.startsWith(`${MCP_PATH}/`) ||
    path.startsWith('/oauth/') ||
    path.startsWith('/.well-known/oauth-')
  );
}

const providers = new Map<string, OAuthProvider<ProviderEnv>>();

/** One provider per origin the Worker answers on (workers.dev, a domain). */
function providerFor(origin: string): OAuthProvider<ProviderEnv> {
  let p = providers.get(origin);
  if (p) return p;
  p = new OAuthProvider<ProviderEnv>({
    apiRoute: MCP_PATH,
    apiHandler: { fetch: (req, env, ctx) => api(req, env, ctx) },
    defaultHandler: { fetch: (req, env) => pages(req, env as ProviderEnv) },
    authorizeEndpoint: AUTHORIZE_PATH,
    tokenEndpoint: TOKEN_PATH,
    clientRegistrationEndpoint: REGISTER_PATH,
    scopesSupported: [SCOPE],
    requiredScopes: [SCOPE],
    accessTokenTTL: ACCESS_TTL_S,
    refreshTokenTTL: REFRESH_TTL_S,
    resourceMetadata: {
      resource: `${origin}${MCP_PATH}`,
      authorization_servers: [origin],
      resource_name: 'Theodore',
    },
    tokenExchangeCallback: refreshUpstream,
  });
  providers.set(origin, p);
  return p;
}

/** Everything MCP and OAuth, if configured; `null`: not an MCP path. */
export async function mcpFetch(
  request: Request,
  env: McpBindings,
  ctx: ExecutionContext,
  deps: () => Deps,
): Promise<Response> {
  try {
    if (!env.OAUTH_KV || !env.MCP_KEY_WRAP) {
      throw new CloudError(404, 'cloud.not_found', 'no such route');
    }
    const d = deps();
    const url = new URL(request.url);
    if (url.pathname.startsWith('/oauth/') && d.limit) {
      const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
      if (!(await d.limit('public', ip))) {
        throw new CloudError(429, 'cloud.rate_limited', 'too many requests');
      }
    }
    const origins = (env.MCP_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim().replace(/\/+$/, ''))
      .filter((o) => o !== '');
    return await providerFor(url.origin).fetch(
      request,
      {
        OAUTH_KV: env.OAUTH_KV,
        MCP_DEPS: d,
        MCP_ORIGINS: [...DEFAULT_MCP_ORIGINS, ...origins],
      },
      ctx,
    );
  } catch (e) {
    if (e instanceof CloudError) return errorResponse(e);
    console.error('mcp.internal', e instanceof Error ? e.name : typeof e);
    return errorResponse(
      new CloudError(500, 'cloud.internal', 'internal error'),
    );
  }
}

// ── the MCP endpoint ─────────────────────────────────────────────────────

async function api(
  request: Request,
  env: ProviderEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const auth = (ctx as unknown as { auth: OAuthResourceAuth }).auth;
  const props = (ctx as unknown as { props: Props }).props;
  if (!auth.scope.includes(SCOPE)) return insufficientScope(auth, [SCOPE]);
  const url = new URL(request.url);
  if (url.pathname !== MCP_PATH) {
    return errorResponse(
      new CloudError(404, 'cloud.not_found', 'no such route'),
    );
  }
  // DNS rebinding: a browser page may call only from an allowed origin.
  const origin = request.headers.get('origin');
  if (
    origin !== null &&
    origin !== url.origin &&
    !env.MCP_ORIGINS.includes(origin)
  ) {
    return Response.json(
      {
        jsonrpc: '2.0',
        error: { code: -32600, message: 'origin not allowed' },
      },
      { status: 403 },
    );
  }
  const deps = env.MCP_DEPS;
  if (deps.limit && !(await deps.limit('user', props.userId))) {
    return errorResponse(
      new CloudError(429, 'cloud.rate_limited', 'too many requests'),
    );
  }
  const grant: McpGrant = { userId: props.userId, orgId: props.orgId };
  return handleRpc(request, {
    call: (name, args) => callInHub(deps.hub, url.origin, grant, name, args),
  });
}

/** On refresh: WorkOS refreshes the same session into the same org. */
async function refreshUpstream(o: {
  grantType: GrantType;
  props: Props;
  env: ProviderEnv;
}) {
  if (o.grantType !== GrantType.REFRESH_TOKEN) return;
  const deps = o.env.MCP_DEPS;
  let s: Authentication;
  try {
    s = await deps.workos.refreshSession({
      clientId: deps.clientId,
      refreshToken: o.props.refreshToken,
      organizationId: o.props.orgId,
    });
  } catch (e) {
    if (e instanceof WorkosError && e.status >= 400 && e.status < 500) {
      // Signed out, removed from the org, the session revoked: for good.
      throw new OAuthError('invalid_grant', {
        description: 'the Theodore session ended: sign in again',
      });
    }
    throw unavailable();
  }
  let caller: Caller;
  try {
    caller = await deps.verify(s.access_token);
  } catch (e) {
    if (e instanceof CloudError && e.code === 'cloud.unauthorized') {
      throw new OAuthError('invalid_grant', { description: 'token refused' });
    }
    throw unavailable();
  }
  if (
    caller.userId !== o.props.userId ||
    caller.organizationId !== o.props.orgId
  ) {
    throw new OAuthError('invalid_grant', {
      description: 'the session no longer reaches this organization',
    });
  }
  return { newProps: { ...o.props, refreshToken: s.refresh_token } };
}

const unavailable = () =>
  new OAuthError('temporarily_unavailable', {
    description: 'sign-in is unavailable, try again',
    statusCode: 503,
  });

// ── the pages a browser sees ─────────────────────────────────────────────

const escape = (v: string) =>
  v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The Theodore tile (mobile/assets/src/logo.svg), inline: the page's CSP
 *  loads nothing. */
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" aria-hidden="true" viewBox="0 0 1024 1024"><defs><radialGradient id="blob" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#0C5BC0" stop-opacity="0.95"/><stop offset="1" stop-color="#0C5BC0" stop-opacity="0"/></radialGradient><linearGradient id="glass" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.72"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0.14"/></linearGradient><linearGradient id="rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity="1"/><stop offset="0.5" stop-color="#FFFFFF" stop-opacity="0.25"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0.7"/></linearGradient><clipPath id="tile"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath><clipPath id="lenses"><circle cx="352" cy="500" r="150"/><circle cx="672" cy="500" r="150"/></clipPath></defs><rect x="100" y="100" width="824" height="824" rx="185" fill="#3F86D6"/><g clip-path="url(#tile)"><circle cx="300" cy="330" r="300" fill="url(#blob)"/><circle cx="740" cy="380" r="320" fill="url(#blob)"/><circle cx="520" cy="800" r="330" fill="url(#blob)"/></g><g fill="#03306B" fill-opacity="0.18" transform="translate(0 26)"><circle cx="352" cy="500" r="150"/><circle cx="672" cy="500" r="150"/></g><circle cx="352" cy="500" r="150" fill="url(#glass)" fill-opacity="0.75"/><circle cx="672" cy="500" r="150" fill="url(#glass)" fill-opacity="0.75"/><g clip-path="url(#lenses)" stroke="#FFFFFF" stroke-opacity="0.45" stroke-width="40"><path d="M100 330 L 924 330"/><path d="M100 440 L 924 440"/><path d="M100 550 L 924 550"/><path d="M100 660 L 924 660"/></g><g fill="none" stroke="url(#rim)" stroke-width="6"><circle cx="352" cy="500" r="150"/><circle cx="672" cy="500" r="150"/></g><path d="M500 486 C 506 456, 518 456, 524 486" fill="none" stroke="#FFFFFF" stroke-width="20" stroke-linecap="round"/><g fill="none" stroke="#FFFFFF" stroke-width="12" stroke-linecap="round"><path d="M250 430 A 120 120 0 0 1 300 380"/><path d="M570 430 A 120 120 0 0 1 620 380"/></g><rect x="100" y="100" width="824" height="824" rx="185" fill="none" stroke="#FFFFFF" stroke-opacity="0.6" stroke-width="6"/></svg>`;

/** The pages look like the app: HeroUI's tokens (ui/), light and dark. */
const STYLE = `
:root{color-scheme:light dark;--bg:oklch(.9702 0 0);--fg:oklch(.2103 .0059 285.89);--surface:#fff;--muted:oklch(.5517 .0138 285.94);--default:oklch(94% .001 286.375);--sep:oklch(92% .004 286.32);--accent:oklch(.6204 .195 253.83);--accent-fg:oklch(.9911 0 0);--warn-bg:color-mix(in oklab,oklch(.78 .16 75) 14%,transparent);--r:.75rem}
@media (prefers-color-scheme:dark){:root{--bg:oklch(12% .005 285.823);--fg:oklch(.9911 0 0);--surface:oklch(.2103 .0059 285.89);--muted:oklch(70.5% .015 286.067);--default:oklch(27.4% .006 286.033);--sep:oklch(27.4% .006 286.033)}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem;background:var(--bg);color:var(--fg);font:15px/1.5 'Geist Variable','Geist',ui-sans-serif,system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:26rem;background:var(--surface);border-radius:calc(var(--r)*1.5);padding:2rem;box-shadow:0 1px 2px rgb(0 0 0/.06),0 8px 24px rgb(0 0 0/.06)}
header{display:flex;flex-direction:column;align-items:center;text-align:center;gap:.75rem;margin-bottom:1.25rem}
h1{font-size:1.25rem;font-weight:600;margin:0;letter-spacing:-.01em}
p{margin:0 0 .75rem}
.muted{color:var(--muted);font-size:.875rem}
.note{background:var(--warn-bg);border-radius:var(--r);padding:.625rem .75rem;font-size:.875rem}
ul{margin:0 0 1rem;padding:0;list-style:none;border-top:1px solid var(--sep)}
li{padding:.5rem 0;border-bottom:1px solid var(--sep);font-size:.875rem}
form{margin:0}
.actions{display:flex;gap:.5rem;margin-top:1.25rem}
button{flex:1;font:inherit;font-weight:500;border:0;border-radius:var(--r);padding:.625rem 1rem;cursor:pointer;background:var(--default);color:var(--fg);transition:filter .15s}
button:hover{filter:brightness(.96)}
button.primary{background:var(--accent);color:var(--accent-fg)}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
label{display:flex;align-items:center;gap:.625rem;padding:.625rem .75rem;border-radius:var(--r);background:var(--default);margin:.375rem 0;cursor:pointer}
input[type=radio]{accent-color:var(--accent);margin:0}
`;

function page(title: string, body: string, headers = new Headers()): Response {
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set(
    'content-security-policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  );
  headers.set('x-frame-options', 'DENY');
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${escape(title)}</title><style>${STYLE}</style>` +
      `<main><header>${LOGO}<h1>${escape(title)}</h1></header>${body}</main></html>`,
    { status: 200, headers },
  );
}

function problem(message: string, status = 400): Response {
  const r = page('Theodore', `<p>${escape(message)}</p>`);
  return new Response(r.body, { status, headers: r.headers });
}

async function pages(request: Request, env: ProviderEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER!;
  const url = new URL(request.url);
  try {
    if (url.pathname === AUTHORIZE_PATH && request.method === 'GET') {
      return await consent(oauth, request);
    }
    if (url.pathname === AUTHORIZE_PATH && request.method === 'POST') {
      return await decided(oauth, request, env.MCP_DEPS);
    }
    if (url.pathname === CALLBACK_PATH && request.method === 'GET') {
      return await callback(oauth, request, env.MCP_DEPS);
    }
    if (url.pathname === ORG_PATH && request.method === 'POST') {
      return await orgPicked(oauth, request, env.MCP_DEPS);
    }
    return errorResponse(
      new CloudError(404, 'cloud.not_found', 'no such route'),
    );
  } catch (e) {
    if (e instanceof AuthorizationError) {
      if (e.redirectTo) return redirect(e.redirectTo);
      return problem(`This sign-in link can't be used: ${e.description}`);
    }
    if (e instanceof CloudError || e instanceof WorkosError) {
      const status = e instanceof CloudError ? e.status : 502;
      return problem(
        'Signing in to Theodore failed. Try again from Claude.',
        status,
      );
    }
    throw e;
  }
}

const redirect = (to: string, headers = new Headers()) => {
  headers.set('location', to);
  headers.set('cache-control', 'no-store');
  return new Response(null, { status: 302, headers });
};

/** GET /oauth/authorize: what is asking, and Allow / Deny. */
async function consent(oauth: OAuthHelpers, request: Request) {
  const req = await oauth.parseAuthRequest(request);
  const d = await oauth.describeConsent(req);
  const t = await oauth.beginConsent(req);
  const who = d.clientDomain
    ? `<strong>${escape(d.clientName)}</strong> (published by ${escape(d.clientDomain)})`
    : `<strong>${escape(d.clientName)}</strong> (a name the app gave itself)`;
  return page(
    'Connect to Theodore',
    `<p>${who} wants to use Theodore for you.</p>` +
      `<p class="muted">Access goes to <strong>${escape(d.redirectHost)}</strong>.</p>` +
      (d.redirectIsLoopback
        ? '<p class="note"><strong>That is an app on your computer.</strong> Continue only if you just started connecting from it.</p>'
        : '') +
      '<ul><li>Sees your computers and their projects</li>' +
      '<li>Starts and steers spaces on computers you trust for it</li>' +
      '<li>Edit or Run waits for your yes on the computer</li></ul>' +
      '<p class="muted">Each computer decides: it takes requests only after you trust “Claude (MCP)” there.</p>' +
      `<form method="post" action="${AUTHORIZE_PATH}"><input type="hidden" name="handle" value="${escape(t.handle)}">` +
      '<div class="actions"><button name="decision" value="deny">Deny</button><button class="primary" name="decision" value="allow">Allow and sign in</button></div></form>',
    t.headers,
  );
}

/** POST /oauth/authorize: the user decided. */
async function decided(oauth: OAuthHelpers, request: Request, deps: Deps) {
  const form = await request.formData();
  const handle = String(form.get('handle') ?? '');
  if (form.get('decision') !== 'allow') {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(request, handle, {
    scope: [SCOPE],
  });
  const up = await oauth.beginUpstream(approved.request, {
    headers: approved.headers,
  });
  return redirect(
    authkitAuthorizeUrl(deps.apiBase ?? 'https://api.workos.com', {
      clientId: deps.clientId,
      redirectUri: new URL(CALLBACK_PATH, request.url).toString(),
      state: up.state,
    }),
    up.headers,
  );
}

/** GET /oauth/callback: AuthKit's code. */
async function callback(oauth: OAuthHelpers, request: Request, deps: Deps) {
  const back = await oauth.finishUpstream(request);
  const q = new URL(request.url).searchParams;
  const code = q.get('code');
  if (q.get('error') || !code) {
    return redirect(
      authorizationErrorRedirect(back.request, 'access_denied'),
      back.headers,
    );
  }
  let session: Authentication;
  try {
    session = await deps.workos.authenticateWithCode({
      clientId: deps.clientId,
      code,
    });
  } catch (e) {
    if (
      e instanceof WorkosError &&
      e.code === 'organization_selection_required' &&
      typeof e.body?.pending_authentication_token === 'string'
    ) {
      return pickOrg(oauth, back.request, back.headers, e.body);
    }
    throw e;
  }
  return finish(oauth, back.request, back.headers, deps, session, request);
}

/** A user in 2+ orgs: which one Claude works in. */
async function pickOrg(
  oauth: OAuthHelpers,
  req: AuthRequest,
  headers: Headers,
  body: Record<string, unknown>,
) {
  const orgs = (Array.isArray(body.organizations) ? body.organizations : [])
    .filter(
      (o): o is { id: string; name: string } =>
        !!o &&
        typeof (o as { id?: unknown }).id === 'string' &&
        typeof (o as { name?: unknown }).name === 'string',
    )
    .slice(0, 100);
  // A new transaction for the same approved request, bound to this browser.
  const up = await oauth.beginUpstream(req, {
    data: { pending: body.pending_authentication_token },
    headers,
  });
  const choices = orgs
    .map(
      (o, i) =>
        `<label><input type="radio" name="organization_id" value="${escape(o.id)}"${i === 0 ? ' checked' : ''}> ${escape(o.name)}</label>`,
    )
    .join('');
  return page(
    'Which organization?',
    `<p class="muted">Claude works with the computers of one organization.</p>` +
      `<form method="post" action="${ORG_PATH}?state=${encodeURIComponent(up.state)}">${choices}` +
      '<div class="actions"><button class="primary">Continue</button></div></form>',
    up.headers,
  );
}

/** POST /oauth/org: the org picked. */
async function orgPicked(oauth: OAuthHelpers, request: Request, deps: Deps) {
  const back = await oauth.finishUpstream<{ pending?: unknown }>(request);
  const form = await request.formData();
  const org = form.get('organization_id');
  const pending = back.data?.pending;
  if (typeof org !== 'string' || org === '' || typeof pending !== 'string') {
    return redirect(
      authorizationErrorRedirect(back.request, 'access_denied'),
      back.headers,
    );
  }
  const session = await deps.workos.selectOrganization({
    clientId: deps.clientId,
    pendingAuthenticationToken: pending,
    organizationId: org,
  });
  return finish(oauth, back.request, back.headers, deps, session, request);
}

/**
 * The session's user and org, checked from its access token (the
 * personal org made and switched to if it has none), then the grant.
 */
async function finish(
  oauth: OAuthHelpers,
  req: AuthRequest,
  headers: Headers,
  deps: Deps,
  session: Authentication,
  request: Request,
) {
  let caller = await deps.verify(session.access_token);
  let refreshToken = session.refresh_token;
  if (!caller.organizationId) {
    const personal = await ensurePersonalOrganization(
      caller.userId,
      deps.workos,
    );
    const s = await deps.workos.refreshSession({
      clientId: deps.clientId,
      refreshToken,
      organizationId: personal.organization_id,
    });
    caller = await deps.verify(s.access_token);
    refreshToken = s.refresh_token;
  }
  if (!caller.organizationId) {
    throw new CloudError(
      403,
      'fleet.no_org',
      'the session has no organization',
    );
  }
  const grant: McpGrant = {
    userId: caller.userId,
    orgId: caller.organizationId,
  };
  await enableInHub(deps.hub, new URL(request.url).origin, grant);
  const props: Props = { ...grant, refreshToken };
  const { redirectTo } = await oauth.completeAuthorization({
    request: req,
    userId: encodeURIComponent(caller.userId),
    metadata: { org: caller.organizationId },
    scope: req.scope.length ? req.scope : [SCOPE],
    props,
  });
  return redirect(redirectTo, headers);
}
