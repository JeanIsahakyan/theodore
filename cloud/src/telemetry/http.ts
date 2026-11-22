/**
 * One `http request` record per request the Worker answers: the route (a
 * fixed label, never the raw path), method, status, latency, and the kind of
 * device when the request says (docs/telemetry.md "Cloud").
 */
import { ERROR_HEADER } from '../errors';
import type { Logger } from './log';

/** The device kinds the fleet knows, as far as an HTTP request tells. */
export type DeviceKind = 'mobile' | 'web' | 'desktop' | 'mcp';

const ROUTES = new Set([
  '/v1/health',
  '/v1/orgs',
  '/v1/orgs/personal',
  '/v1/account',
  '/v1/fleet/ws',
  '/v1/fleet/request',
  '/v1/auth/select-organization',
  '/v1/telemetry/logs',
  '/mcp',
  '/oauth/register',
  '/oauth/authorize',
  '/oauth/callback',
  '/oauth/org',
  '/oauth/token',
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server',
]);

/** A known route as itself; anything else is `other` (paths aren't logged). */
export function routeLabel(path: string): string {
  if (ROUTES.has(path)) return path;
  if (path.startsWith('/mcp/')) return '/mcp/*';
  if (path.startsWith('/oauth/')) return '/oauth/*';
  if (path.startsWith('/.well-known/')) return '/.well-known/*';
  return 'other';
}

/**
 * Who is calling, from what the request itself says: the MCP paths are
 * Claude; a browser from one of the web app's origins is `web`; the app's
 * own clients send `user-agent: theodore` (a computer) or Expo's / the
 * platform HTTP stack's (a phone). Unknown stays unknown.
 */
export function deviceKind(
  request: Request,
  webOrigins: readonly string[],
): DeviceKind | undefined {
  const path = new URL(request.url).pathname;
  if (path === '/mcp' || path.startsWith('/mcp/')) return 'mcp';
  const origin = request.headers.get('origin');
  if (origin !== null && webOrigins.includes(origin)) return 'web';
  const ua = request.headers.get('user-agent') ?? '';
  if (/^theodore\b/i.test(ua)) return 'desktop';
  if (/\b(Expo|okhttp|CFNetwork|Darwin|Android)\b/.test(ua)) return 'mobile';
  return undefined;
}

/** Cloudflare's data center code for the request, when the runtime adds it. */
export function requestRegion(request: Request): string | undefined {
  const cf = (request as { cf?: { colo?: unknown } }).cf;
  return typeof cf?.colo === 'string' ? cf.colo : undefined;
}

/** Runs `serve`, then logs the request; the response is returned unchanged. */
export async function logged(
  request: Request,
  log: Logger,
  webOrigins: readonly string[],
  serve: () => Promise<Response>,
): Promise<Response> {
  const started = Date.now();
  const route = routeLabel(new URL(request.url).pathname);
  const kind = deviceKind(request, webOrigins);
  let response: Response;
  try {
    response = await serve();
  } catch (e) {
    log.exception('http request failed', {
      route,
      method: request.method,
      ms: Date.now() - started,
      device_kind: kind,
    });
    throw e;
  }
  log.info('http request', {
    route,
    method: request.method,
    status: response.status,
    ms: Date.now() - started,
    device_kind: kind,
    'cloud.region': requestRegion(request),
    'error.code': response.headers.get(ERROR_HEADER) ?? undefined,
  });
  return response;
}
