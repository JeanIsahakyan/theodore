/**
 * Who is calling: the app's WorkOS AuthKit access token, checked the same way
 * the app checks it (crates/account-workos/src/jwt.rs), but strictly — here
 * an unreachable JWKS fails the request instead of being skipped.
 *
 * ```text
 * Authorization: Bearer <access JWT>
 *   ─▶ JWKS <api>/sso/jwks/<client_id> ─▶ RS256 signature
 *   ─▶ iss = <api> or <api>/user_management/client_… ─▶ exp (60 s leeway)
 *   ─▶ client_id, when present, = ours or the issuer's ─▶ sub
 * ```
 */
import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTVerifyGetKey,
} from 'jose';
import { CloudError } from './errors';

/** The signed-in user a request acts for. */
export interface Caller {
  userId: string;
  sessionId?: string;
  organizationId?: string;
  role?: string;
  permissions: string[];
}

export interface VerifyOptions {
  apiBase: string;
  clientId: string;
  keys: JWTVerifyGetKey;
}

const LEEWAY_SECONDS = 60;

const trim = (s: string) => s.replace(/\/+$/, '');

// One remote key set per URL for the isolate's lifetime: jose caches the keys
// and refetches when a token names an unknown `kid`.
const remoteSets = new Map<string, JWTVerifyGetKey>();

export function remoteKeys(apiBase: string, clientId: string): JWTVerifyGetKey {
  const url = `${trim(apiBase)}/sso/jwks/${encodeURIComponent(clientId)}`;
  let set = remoteSets.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url));
    remoteSets.set(url, set);
  }
  return set;
}

/**
 * AuthKit names a client in the issuer, `<api>/user_management/<client_id>`;
 * it can be the environment's own client rather than the app's, and the
 * signature already ties the token to the environment, so any client id is
 * accepted there (same rule as the app).
 */
export function issuerAccepted(iss: string, apiBase: string): boolean {
  const base = trim(apiBase);
  const got = trim(iss);
  if (got === base) return true;
  const client = got.startsWith(`${base}/user_management/`)
    ? got.slice(`${base}/user_management/`.length)
    : undefined;
  return (
    client !== undefined &&
    client.startsWith('client_') &&
    !client.includes('/')
  );
}

const unauthorized = (why: string) =>
  new CloudError(401, 'cloud.unauthorized', why);

export function bearer(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(header);
  if (!match?.[1]) throw unauthorized('missing bearer token');
  return match[1];
}

export async function verifyAccessToken(
  token: string,
  o: VerifyOptions,
): Promise<Caller> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, o.keys, {
      algorithms: ['RS256'],
      clockTolerance: LEEWAY_SECONDS,
      requiredClaims: ['exp', 'sub'],
    }));
  } catch (e) {
    if (
      e instanceof joseErrors.JWKSTimeout ||
      e instanceof joseErrors.JWKSInvalid ||
      // jose's own words for a JWKS endpoint that didn't answer 200
      (e instanceof joseErrors.JOSEError &&
        e.message.includes('JSON Web Key Set HTTP response')) ||
      (e instanceof TypeError && /fetch/i.test(e.message))
    ) {
      throw new CloudError(
        503,
        'cloud.jwks_unavailable',
        'signing keys unavailable',
      );
    }
    if (e instanceof joseErrors.JWTExpired) throw unauthorized('token expired');
    if (e instanceof joseErrors.JOSEError) throw unauthorized('invalid token');
    throw e;
  }

  const iss = payload.iss;
  if (typeof iss !== 'string' || !issuerAccepted(iss, o.apiBase)) {
    throw unauthorized('unexpected issuer');
  }
  const issuerClient = trim(iss).split('/user_management/')[1];
  const clientId = payload['client_id'];
  if (
    clientId !== undefined &&
    clientId !== o.clientId &&
    clientId !== issuerClient
  ) {
    throw unauthorized('token is for another client');
  }
  const sub = payload.sub;
  if (typeof sub !== 'string' || sub === '') throw unauthorized('no subject');

  const str = (v: unknown) =>
    typeof v === 'string' && v !== '' ? v : undefined;
  const permissions = payload['permissions'];
  return {
    userId: sub,
    sessionId: str(payload['sid']),
    organizationId: str(payload['org_id']),
    role: str(payload['role']),
    permissions: Array.isArray(permissions)
      ? permissions.filter((p): p is string => typeof p === 'string')
      : [],
  };
}
