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
 *
 * ```text
 * app sign-in ─▶ 403 organization_selection_required {pending_authentication_token, organizations}
 *   ─▶ user picks ─▶ POST /v1/auth/select-organization {pending_authentication_token, organization_id}
 *   ─▶ cloud: authenticate grant organization-selection + client_secret ─▶ session ─▶ app
 *      (the app validates the access token itself, as after a code exchange)
 * ```
 */
import { bearer, remoteKeys, verifyAccessToken, type Caller } from './auth';
import { field, readJson } from './body';
import { CloudError, errorResponse, json } from './errors';
import { ensurePersonalOrganization, listOrganizations } from './orgs';
import { upstream, WorkosClient, WorkosError, type Workos } from './workos';

export interface Env {
  WORKOS_API_KEY: string;
  WORKOS_CLIENT_ID: string;
  WORKOS_API_BASE?: string;
}

export interface Deps {
  workos: Workos;
  clientId: string;
  verify: (token: string) => Promise<Caller>;
}

/** A declared body over this is refused unread; `readJson` caps the rest. */
const MAX_BODY_BYTES = 64 * 1024;

export function depsFor(env: Env): Deps {
  if (!env.WORKOS_API_KEY || !env.WORKOS_CLIENT_ID) {
    throw new CloudError(500, 'cloud.config', 'cloud is not configured');
  }
  const apiBase = env.WORKOS_API_BASE ?? 'https://api.workos.com';
  const keys = remoteKeys(apiBase, env.WORKOS_CLIENT_ID);
  return {
    workos: new WorkosClient(env.WORKOS_API_KEY, apiBase),
    clientId: env.WORKOS_CLIENT_ID,
    verify: (token) =>
      verifyAccessToken(token, {
        apiBase,
        clientId: env.WORKOS_CLIENT_ID,
        keys,
      }),
  };
}

type Route = (request: Request, deps: Deps) => Promise<Response>;

const routes: Record<string, Partial<Record<string, Route>>> = {
  '/v1/health': { GET: async () => json({ ok: true }) },
  '/v1/orgs': {
    GET: async (request, deps) => {
      const caller = await deps.verify(bearer(request));
      return json({
        organizations: await listOrganizations(caller.userId, deps.workos),
      });
    },
  },
  '/v1/orgs/personal': {
    POST: async (request, deps) => {
      const caller = await deps.verify(bearer(request));
      return json(await ensurePersonalOrganization(caller.userId, deps.workos));
    },
  },
  // No bearer: the user has no session yet. The pending token is the
  // credential (single use, short-lived, issued by WorkOS to this user).
  '/v1/auth/select-organization': {
    POST: async (request, deps) => {
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
