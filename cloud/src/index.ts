/**
 * Theodore cloud: the server side of the Theodore account (docs/cloud.md).
 *
 * ```text
 * app ─HTTPS─▶ Worker ─ bearer access JWT ─▶ verify (JWKS) ─▶ route ─▶ WorkOS API (API key)
 * ```
 *
 * | Route | Does |
 * | --- | --- |
 * | GET  /v1/health | liveness, no auth |
 * | GET  /v1/orgs | the caller's organizations (switcher), personal first |
 * | POST /v1/orgs/personal | the caller's personal organization, created once (src/orgs.ts) |
 * | POST /v1/auth/select-organization | finishes a sign-in that needs an org picked (needs the secret) |
 * | GET  /v1/fleet/ws | WebSocket to the org's fleet hub (src/fleet/, docs/fleet.md) |
 * | POST /v1/fleet/request | a one-shot signed fleet request, no socket (a push action) |
 *
 * Rate limits (Cloudflare's rate-limiting bindings; 429 `cloud.rate_limited`):
 * the unauthenticated routes (org selection, the fleet upgrade) per client
 * IP, the authenticated ones per user.
 *
 * CORS: only for the web app's origins (`WEB_ORIGINS`), only on the routes
 * it calls (`/v1/orgs*`, `/v1/auth/select-organization`,
 * `/v1/fleet/request`); no credentials, `Authorization` and `Content-Type`.
 *
 * ```text
 * app sign-in ─▶ 403 organization_selection_required {pending_authentication_token, organizations}
 *   ─▶ user picks ─▶ POST /v1/auth/select-organization {pending_authentication_token, organization_id}
 *   ─▶ cloud: authenticate grant organization-selection + client_secret ─▶ session ─▶ app
 *      (the app validates the access token itself, as after a code exchange)
 * ```
 */
import { bearer, verifierFor, type Caller } from './auth';
import { field, readJson } from './body';
import { CloudError, errorResponse, json } from './errors';
import {
  fleetConnect,
  fleetRequest,
  requestCaller,
  type HubFor,
} from './fleet/route';
import { ensurePersonalOrganization, listOrganizations } from './orgs';
import { upstream, WorkosClient, WorkosError, type Workos } from './workos';

export interface Env {
  WORKOS_API_KEY: string;
  WORKOS_CLIENT_ID: string;
  WORKOS_API_BASE?: string;
  ORG_HUB?: DurableObjectNamespace;
  /** Per client IP: routes without a session, and fleet upgrades. */
  RL_PUBLIC?: RateLimit;
  /** Per signed-in user: the org routes and one-shot fleet requests. */
  RL_USER?: RateLimit;
  /** The web app's origins, comma-separated: CORS and browser sockets. */
  WEB_ORIGINS?: string;
  /** Expo access token (secret), if the Expo project requires one. */
  EXPO_ACCESS_TOKEN?: string;
}

export { OrgHub } from './fleet/org-hub';

export interface Deps {
  workos: Workos;
  clientId: string;
  verify: (token: string) => Promise<Caller>;
  /** The org's fleet hub; absent: the fleet route answers cloud.config. */
  hub?: HubFor;
  /** `false`: over the limit for `key` in `bucket`. Absent: no limits. */
  limit?: (bucket: 'public' | 'user', key: string) => Promise<boolean>;
  /** Origins of the web app (set by `handle` from its argument). */
  webOrigins?: readonly string[];
}

/** `WEB_ORIGINS` as a list: trimmed, empty entries and trailing `/` gone. */
export function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter((o) => o !== '');
}

/** Routes the web app calls from the browser. */
const corsPath = (path: string) =>
  path === '/v1/orgs' ||
  path.startsWith('/v1/orgs/') ||
  path === '/v1/auth/select-organization' ||
  path === '/v1/fleet/request';

/** CORS headers for an allowed origin; none for any other. */
function corsHeaders(
  request: Request,
  path: string,
  webOrigins: readonly string[],
): Record<string, string> | null {
  const origin = request.headers.get('origin');
  if (!corsPath(path) || origin === null || !webOrigins.includes(origin)) {
    return null;
  }
  return { 'access-control-allow-origin': origin, vary: 'Origin' };
}

const PREFLIGHT = {
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Authorization, Content-Type',
  'access-control-max-age': '600',
};

async function within(
  deps: Deps,
  bucket: 'public' | 'user',
  key: string,
): Promise<void> {
  if (deps.limit && !(await deps.limit(bucket, key))) {
    throw new CloudError(429, 'cloud.rate_limited', 'too many requests');
  }
}

/** The client's IP as Cloudflare saw it; one bucket for unknowns. */
const clientIp = (request: Request) =>
  request.headers.get('cf-connecting-ip') ?? 'unknown';

/** A declared body over this is refused unread; `readJson` caps the rest. */
const MAX_BODY_BYTES = 64 * 1024;

export function depsFor(env: Env): Deps {
  if (!env.WORKOS_API_KEY || !env.WORKOS_CLIENT_ID) {
    throw new CloudError(500, 'cloud.config', 'cloud is not configured');
  }
  const apiBase = env.WORKOS_API_BASE ?? 'https://api.workos.com';
  const ns = env.ORG_HUB;
  return {
    workos: new WorkosClient(env.WORKOS_API_KEY, apiBase),
    clientId: env.WORKOS_CLIENT_ID,
    verify: verifierFor(apiBase, env.WORKOS_CLIENT_ID),
    hub: ns ? (orgId) => ns.get(ns.idFromName(orgId)) : undefined,
    limit: async (bucket, key) => {
      const rl = bucket === 'public' ? env.RL_PUBLIC : env.RL_USER;
      if (!rl) return true;
      return (await rl.limit({ key })).success;
    },
  };
}

type Route = (request: Request, deps: Deps) => Promise<Response>;

const routes: Record<string, Partial<Record<string, Route>>> = {
  '/v1/health': { GET: async () => json({ ok: true }) },
  '/v1/orgs': {
    GET: async (request, deps) => {
      const caller = await deps.verify(bearer(request));
      await within(deps, 'user', caller.userId);
      return json({
        organizations: await listOrganizations(caller.userId, deps.workos),
      });
    },
  },
  '/v1/orgs/personal': {
    POST: async (request, deps) => {
      const caller = await deps.verify(bearer(request));
      await within(deps, 'user', caller.userId);
      return json(await ensurePersonalOrganization(caller.userId, deps.workos));
    },
  },
  '/v1/fleet/ws': {
    GET: async (request, deps) => {
      await within(deps, 'public', clientIp(request));
      return fleetConnect(request, deps.verify, deps.hub, deps.webOrigins);
    },
  },
  '/v1/fleet/request': {
    POST: async (request, deps) => {
      const caller = await requestCaller(request, deps.verify);
      await within(deps, 'user', caller.userId);
      const body = await readJson(request, MAX_BODY_BYTES);
      return fleetRequest(request.url, caller, body, deps.hub);
    },
  },
  // No bearer: the user has no session yet. The pending token is the
  // credential (single use, short-lived, issued by WorkOS to this user).
  '/v1/auth/select-organization': {
    POST: async (request, deps) => {
      await within(deps, 'public', clientIp(request));
      const body = await readJson(request, MAX_BODY_BYTES);
      const session = await deps.workos.selectOrganization({
        clientId: deps.clientId,
        pendingAuthenticationToken: field(
          body,
          'pending_authentication_token',
          4096,
        ),
        organizationId: field(body, 'organization_id', 128),
      });
      return json({
        user: session.user,
        organization_id: session.organization_id ?? null,
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      });
    },
  },
};

/** The web app's origins may read `response` (when `cors` says so). */
function withCors(
  response: Response,
  cors: Record<string, string> | null,
): Response {
  if (!cors) return response;
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
  return out;
}

export async function handle(
  request: Request,
  deps: () => Deps,
  webOrigins: readonly string[] = [],
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const cors = corsHeaders(request, path, webOrigins);
  if (request.method === 'OPTIONS' && corsPath(path)) {
    // A preflight from anywhere else gets no CORS headers: the browser stops.
    return new Response(null, {
      status: 204,
      headers: cors ? { ...cors, ...PREFLIGHT } : {},
    });
  }
  return withCors(await dispatch(request, path, deps, webOrigins), cors);
}

async function dispatch(
  request: Request,
  path: string,
  deps: () => Deps,
  webOrigins: readonly string[],
): Promise<Response> {
  try {
    const methods = routes[path];
    if (!methods) throw new CloudError(404, 'cloud.not_found', 'no such route');
    const handler = methods[request.method];
    if (!handler) {
      throw new CloudError(
        405,
        'cloud.method',
        `${request.method} not allowed`,
      );
    }
    const length = Number(request.headers.get('content-length') ?? 0);
    if (length > MAX_BODY_BYTES) {
      throw new CloudError(413, 'cloud.too_large', 'request body too large');
    }
    return await handler(request, { ...deps(), webOrigins });
  } catch (e) {
    if (e instanceof CloudError) return errorResponse(e);
    if (e instanceof WorkosError) return errorResponse(upstream(e));
    // Unexpected: log the kind, never the request (it carries a token).
    console.error('cloud.internal', e instanceof Error ? e.name : typeof e);
    return errorResponse(
      new CloudError(500, 'cloud.internal', 'internal error'),
    );
  }
}

export default {
  fetch: (request, env) =>
    handle(request, () => depsFor(env), parseOrigins(env.WEB_ORIGINS)),
} satisfies ExportedHandler<Env>;
