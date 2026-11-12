/**
 * `GET /v1/fleet/ws`: the Worker side of a fleet connection.
 *
 * ```text
 * Upgrade: websocket + Bearer <access JWT> ─▶ verify ─▶ org_id? ─▶ OrgHub(idFromName(org_id))
 *   caller {userId, orgId, sessionId, expMs} in x-theodore-fleet-caller
 *   (any incoming one replaced; the token itself isn't forwarded)
 * ```
 */
import { bearer, type Caller } from '../auth';
import { CloudError } from '../errors';
import type { FleetCaller } from './hub';
import { CALLER_HEADER } from './org-hub';

/** The org's hub, as the Worker reaches it (a DO stub in production). */
export type HubFor = (orgId: string) => {
  fetch(request: Request): Promise<Response>;
};

export async function fleetConnect(
  request: Request,
  verify: (token: string) => Promise<Caller>,
  hubFor: HubFor | undefined,
): Promise<Response> {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    throw new CloudError(
      426,
      'fleet.upgrade_required',
      'expected a WebSocket upgrade',
    );
  }
  let caller: Caller;
  try {
    caller = await verify(bearer(request));
  } catch (e) {
    if (e instanceof CloudError && e.code === 'cloud.unauthorized') {
      throw new CloudError(401, 'fleet.unauthorized', e.message);
    }
    throw e;
  }
  if (!caller.organizationId) {
    throw new CloudError(403, 'fleet.no_org', 'the token has no organization');
  }
  if (!hubFor) {
    throw new CloudError(500, 'cloud.config', 'the fleet is not configured');
  }
  const forwarded: FleetCaller = {
    userId: caller.userId,
    orgId: caller.organizationId,
    sessionId: caller.sessionId,
    expMs: (caller.expiresAt ?? 0) * 1000,
  };
  const headers = new Headers(request.headers);
  headers.delete('authorization');
  headers.set(CALLER_HEADER, JSON.stringify(forwarded));
  return hubFor(caller.organizationId).fetch(
    new Request(request.url, { method: 'GET', headers }),
  );
}
