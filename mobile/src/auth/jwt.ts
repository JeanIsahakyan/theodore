/**
 * Access-token validation, as `crates/account-workos/src/jwt.rs`: RS256
 * against the provider's JWKS, then issuer, expiry, client and subject.
 */
import { AuthError } from './errors';
import { base64UrlDecode, utf8Decode, utf8Encode } from './encoding';
import { verifyRs256 } from './rsa';

/** Clock skew tolerated on `exp`. */
export const LEEWAY_SECS = 60;

export interface Jwk {
  kid?: string;
  kty: string;
  n?: string;
  e?: string;
}

export interface Jwks {
  keys: Jwk[];
}

export interface Claims {
  sub: string;
  iss?: string;
  exp: number;
  sid?: string;
  org_id?: string;
  /** Role slug; only when an organization is selected. */
  role?: string;
  permissions?: string[];
  client_id?: string;
}

export interface ParsedJwt {
  kid: string | null;
  claims: Claims;
  signingInput: string;
  signature: Uint8Array;
}

const invalid = (m: string) => new AuthError('invalid_token', m);

function b64(part: string): Uint8Array {
  try {
    return base64UrlDecode(part);
  } catch (e) {
    throw invalid(`bad base64url: ${(e as Error).message}`);
  }
}

function json(part: string, what: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(utf8Decode(b64(part)));
  } catch (e) {
    if (e instanceof AuthError) throw e;
    throw invalid(`bad ${what}`);
  }
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw invalid(`bad ${what}`);
  return v as Record<string, unknown>;
}

const optString = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;

export function parseJwt(token: string): ParsedJwt {
  const parts = token.split('.');
  if (parts.length !== 3) throw invalid('not a JWT');
  const [h, p, s] = parts;
  const header = json(h, 'header');
  if (header.alg !== 'RS256') {
    throw invalid(`unexpected alg ${JSON.stringify(header.alg ?? null)}`);
  }
  const raw = json(p, 'claims');
  if (typeof raw.sub !== 'string' || typeof raw.exp !== 'number') {
    throw invalid('bad claims');
  }
  const claims: Claims = {
    sub: raw.sub,
    exp: raw.exp,
    iss: optString(raw.iss),
    sid: optString(raw.sid),
    org_id: optString(raw.org_id),
    role: optString(raw.role),
    client_id: optString(raw.client_id),
    permissions: Array.isArray(raw.permissions)
      ? raw.permissions.filter((x): x is string => typeof x === 'string')
      : [],
  };
  return {
    kid: optString(header.kid) ?? null,
    claims,
    signingInput: `${h}.${p}`,
    signature: b64(s),
  };
}

/** The key `kid` names; with no `kid`, the only RSA key if there is one. */
export function findKey(jwks: Jwks, kid: string | null): Jwk | null {
  const rsa = jwks.keys.filter((k) => k.kty === 'RSA');
  if (kid !== null) return rsa.find((k) => k.kid === kid) ?? null;
  return rsa.length === 1 ? rsa[0] : null;
}

export function verifySignature(parsed: ParsedJwt, key: Jwk): void {
  if (!key.n || !key.e) throw invalid('JWK has no RSA components');
  const ok = verifyRs256(
    { n: b64(key.n), e: b64(key.e) },
    utf8Encode(parsed.signingInput),
    parsed.signature,
  );
  if (!ok) throw invalid("signature doesn't verify");
}

const trim = (s: string) => s.replace(/\/+$/, '');

/**
 * Issuer, expiry, audience and subject. `issuers` are the accepted `iss`
 * values (trailing slashes ignored); `expectedSub` is the user id the
 * token came back with.
 */
export function checkClaims(
  claims: Claims,
  issuers: string[],
  clientId: string,
  expectedSub: string,
  nowSecs: number,
): void {
  // AuthKit names a client in the issuer
  // (`https://api.workos.com/user_management/<client_id>`), which may be the
  // environment's rather than the app's; the signature (keys fetched for
  // the app's client id) already ties the token to the environment.
  const accepted = (iss: string) => {
    const t = trim(iss);
    return issuers.some((i) => {
      const base = trim(i);
      if (t === base) return true;
      const prefix = `${base}/user_management/`;
      if (!t.startsWith(prefix)) return false;
      const c = t.slice(prefix.length);
      return c.startsWith('client_') && !c.includes('/');
    });
  };
  if (claims.iss === undefined || !accepted(claims.iss)) {
    throw invalid(`unexpected issuer ${JSON.stringify(claims.iss ?? null)}`);
  }
  if (claims.exp + LEEWAY_SECS < nowSecs) throw invalid('token expired');
  const iss = trim(claims.iss);
  const at = iss.lastIndexOf('/user_management/');
  const issuerClient =
    at >= 0 ? iss.slice(at + '/user_management/'.length) : undefined;
  if (
    claims.client_id !== undefined &&
    claims.client_id !== clientId &&
    claims.client_id !== issuerClient
  ) {
    throw invalid(`token is for client ${JSON.stringify(claims.client_id)}`);
  }
  if (claims.sub !== expectedSub) {
    throw invalid("token subject doesn't match the user");
  }
}

/** Claims without any check: only for reading `sid` / `exp` of our own token. */
export function peekClaims(token: string): Claims | null {
  try {
    return parseJwt(token).claims;
  } catch {
    return null;
  }
}
