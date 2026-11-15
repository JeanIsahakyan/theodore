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
 *
 * Rate limits (Cloudflare's rate-limiting bindings; 429 `cloud.rate_limited`):
 * the unauthenticated routes (org selection, the fleet upgrade) per client
 * IP, the authenticated ones per user.
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
import { fleetConnect, type HubFor } from './fleet/route';
import { ensurePersonalOrganization, listOrganizations } from './orgs';
import { upstream, WorkosClient, WorkosError, type Workos } from './workos';

export interface Env {
  WORKOS_API_KEY: string;
  WORKOS_CLIENT_ID: string;
  WORKOS_API_BASE?: string;
  ORG_HUB?: DurableObjectNamespace;
  /** Per client IP: routes without a session, and fleet upgrades. */
  RL_PUBLIC?: RateLimit;
  /** Per signed-in user: the org routes. */
  RL_USER?: RateLimit;
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
}

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
      return fleetConnect(request, deps.verify, deps.hub);
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

export async function handle(
  request: Request,
  deps: () => Deps,
): Promise<Response> {
  try {
    const path = new URL(request.url).pathname;
    const methods = routes[path];
    if (!methods) throw new CloudError(404, 'cloud.not_found', 'no such route');
    const route = methods[request.method];
    if (!route) {
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
    return await route(request, deps());
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
  fetch: (request, env) => handle(request, () => depsFor(env)),
} satisfies ExportedHandler<Env>;
