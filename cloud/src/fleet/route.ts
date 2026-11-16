/**
 * The Worker side of the fleet: the socket upgrade and the one-shot HTTP
 * request, both handed to the org's `OrgHub`.
 *
 * ```text
 * GET /v1/fleet/ws, Upgrade: websocket
 *   + Bearer <access JWT>                         (desktop, daemon, phone)
 *   │ or Sec-WebSocket-Protocol: bearer, bearer.<JWT>, Origin in WEB_ORIGINS
 *   │                                             (a browser: no headers on a WebSocket)
 *   ─▶ verify ─▶ org_id? ─▶ OrgHub(idFromName(org_id))
 *      caller {userId, orgId, sessionId, expMs} in x-theodore-fleet-caller
 *      (any incoming one replaced; the token itself isn't forwarded;
 *       the 101 echoes `bearer` when the token came as a subprotocol)
 *
 * POST /v1/fleet/request {device_id, envelope} + Bearer <access JWT>
 *   ─▶ verify ─▶ org_id? ─▶ OrgHub /v1/fleet/request + caller
 *   ─▶ 202 {accepted: true, req_id} │ 409 (400) {accepted: false, req_id, refused: {code, message}}
 * ```
 */
import { bearer, type Caller } from '../auth';
import { CloudError } from '../errors';
import type { FleetCaller, Hub } from './hub';
import { BadMessage, parseHttpRequest } from './wire';

/** The verified caller, Worker ─▶ DO (incoming copies are replaced). */
export const CALLER_HEADER = 'x-theodore-fleet-caller';

/** The org's hub, as the Worker reaches it (a DO stub in production). */
export type HubFor = (orgId: string) => {
  fetch(request: Request): Promise<Response>;
};

/** The subprotocol a browser offers next to `bearer.<token>`, echoed back. */
export const BEARER_PROTOCOL = 'bearer';

/** The path the DO answers one-shot requests on. */
export const REQUEST_PATH = '/v1/fleet/request';

/**
 * The access token of a fleet call: the `Authorization` bearer, or (a
 * browser's WebSocket, which can't send headers) the subprotocol
 * `bearer.<token>`, only from one of the web app's origins.
 */
function fleetToken(
  request: Request,
  webOrigins: readonly string[],
): { token: string; echo: string | null } {
  if (request.headers.has('authorization')) {
    return { token: bearer(request), echo: null };
  }
  const offered = (request.headers.get('sec-websocket-protocol') ?? '')
    .split(',')
    .map((p) => p.trim());
  const carried = offered.find((p) => p.startsWith(`${BEARER_PROTOCOL}.`));
  const origin = request.headers.get('origin');
  if (carried && origin !== null && webOrigins.includes(origin)) {
    const token = carried.slice(BEARER_PROTOCOL.length + 1);
    if (/^[A-Za-z0-9._~-]+$/.test(token)) {
      // The 101 must pick a protocol the browser offered: `bearer` when it
      // offered it (the token then never comes back), else the entry itself.
      const echo = offered.includes(BEARER_PROTOCOL)
        ? BEARER_PROTOCOL
        : carried;
      return { token, echo };
    }
  }
  throw new CloudError(401, 'cloud.unauthorized', 'missing bearer token');
}

/** A verified caller with an org, as the hub gets it. */
async function fleetCaller(
  token: string,
  verify: (token: string) => Promise<Caller>,
): Promise<FleetCaller> {
  let caller: Caller;
  try {
    caller = await verify(token);
  } catch (e) {
    if (e instanceof CloudError && e.code === 'cloud.unauthorized') {
      throw new CloudError(401, 'fleet.unauthorized', e.message);
    }
    throw e;
  }
  if (!caller.organizationId) {
    throw new CloudError(403, 'fleet.no_org', 'the token has no organization');
  }
  return {
    userId: caller.userId,
    orgId: caller.organizationId,
    sessionId: caller.sessionId,
    expMs: (caller.expiresAt ?? 0) * 1000,
  };
}

/** Verifies the bearer of a `POST /v1/fleet/request` (rate limit next). */
export function requestCaller(
  request: Request,
  verify: (token: string) => Promise<Caller>,
): Promise<FleetCaller> {
  let token: string;
  try {
    token = bearer(request);
  } catch (e) {
    if (e instanceof CloudError) {
      throw new CloudError(401, 'fleet.unauthorized', e.message);
    }
    throw e;
  }
  return fleetCaller(token, verify);
}

export async function fleetConnect(
  request: Request,
  verify: (token: string) => Promise<Caller>,
  hubFor: HubFor | undefined,
  webOrigins: readonly string[] = [],
): Promise<Response> {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    throw new CloudError(
      426,
      'fleet.upgrade_required',
      'expected a WebSocket upgrade',
    );
  }
  let found: { token: string; echo: string | null };
  try {
    found = fleetToken(request, webOrigins);
  } catch (e) {
    if (e instanceof CloudError) {
      throw new CloudError(401, 'fleet.unauthorized', e.message);
    }
    throw e;
  }
  const forwarded = await fleetCaller(found.token, verify);
  if (!hubFor) {
    throw new CloudError(500, 'cloud.config', 'the fleet is not configured');
  }
  const headers = new Headers(request.headers);
  headers.delete('authorization');
  // The offer carried the token: the hub gets only what its 101 echoes.
  headers.delete('sec-websocket-protocol');
  if (found.echo) headers.set('sec-websocket-protocol', found.echo);
  headers.set(CALLER_HEADER, JSON.stringify(forwarded));
  return hubFor(forwarded.orgId).fetch(
    new Request(request.url, { method: 'GET', headers }),
  );
}

/** `POST /v1/fleet/request` after the caller checked out: to the org's hub. */
export async function fleetRequest(
  url: string,
  caller: FleetCaller,
  body: Record<string, unknown>,
  hubFor: HubFor | undefined,
): Promise<Response> {
  let parsed;
  try {
    parsed = parseHttpRequest(body);
  } catch (e) {
    if (e instanceof BadMessage) {
      throw new CloudError(400, 'cloud.bad_request', e.message);
    }
    throw e;
  }
  if (!hubFor) {
    throw new CloudError(500, 'cloud.config', 'the fleet is not configured');
  }
  return hubFor(caller.orgId).fetch(
    new Request(new URL(REQUEST_PATH, url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [CALLER_HEADER]: JSON.stringify(caller),
      },
      body: JSON.stringify(parsed),
    }),
  );
}

/** The hub's answer to a one-shot request, as HTTP (inside the DO). */
export async function answerRequest(
  hub: Pick<Hub, 'requestOverHttp'>,
  caller: FleetCaller,
  request: Request,
): Promise<Response> {
  let parsed;
  try {
    parsed = parseHttpRequest(await request.json());
  } catch {
    return Response.json(
      { error: { code: 'cloud.bad_request', message: 'bad request body' } },
      { status: 400 },
    );
  }
  const out = await hub.requestOverHttp(
    caller,
    parsed.device_id,
    parsed.envelope,
  );
  // A refusal is a non-2xx: 400 for a body that isn't a request, else 409.
  const status = out.accepted
    ? 202
    : out.refused.code === 'fleet.bad_message'
      ? 400
      : 409;
  return Response.json(out, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}
