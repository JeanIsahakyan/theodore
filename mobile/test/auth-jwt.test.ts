import { describe, expect, it } from 'vitest';
import { base64UrlDecode, utf8Encode } from '../src/auth/encoding';
import { AuthError } from '../src/auth/errors';
import {
  checkClaims,
  findKey,
  parseJwt,
  verifySignature,
  type Claims,
} from '../src/auth/jwt';
import { verifyRs256 } from '../src/auth/rsa';
import { API, CLIENT_ID, NOW_S, claims, makeKey, sign } from './auth-helpers';

const key = makeKey();
const other = makeKey(2048, 'other');

function kind(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof AuthError ? e.kind : 'other';
  }
}

describe('RS256', () => {
  it('verifies what Node signed, and nothing else', () => {
    const token = sign(key, claims());
    const parsed = parseJwt(token);
    expect(() => verifySignature(parsed, key.jwk)).not.toThrow();
    expect(kind(() => verifySignature(parsed, other.jwk))).toBe(
      'invalid_token',
    );

    const [h, , s] = token.split('.');
    const forged = parseJwt(
      `${h}.${Buffer.from(JSON.stringify(claims({ sub: 'user_2' }))).toString('base64url')}.${s}`,
    );
    expect(kind(() => verifySignature(forged, key.jwk))).toBe('invalid_token');
  });

  it('works with 4096-bit keys and refuses keys under 2048 bits', () => {
    const big = makeKey(4096);
    expect(() =>
      verifySignature(parseJwt(sign(big, claims())), big.jwk),
    ).not.toThrow();
    const small = makeKey(1024);
    expect(
      kind(() => verifySignature(parseJwt(sign(small, claims())), small.jwk)),
    ).toBe('invalid_token');
  });

  it('refuses bad signature lengths and values', () => {
    const n = base64UrlDecode(key.jwk.n);
    const e = base64UrlDecode(key.jwk.e);
    const msg = utf8Encode('hello');
    const parsed = parseJwt(sign(key, claims()));
    expect(verifyRs256({ n, e }, msg, parsed.signature)).toBe(false);
    expect(verifyRs256({ n, e }, msg, parsed.signature.subarray(1))).toBe(
      false,
    );
    expect(
      verifyRs256({ n, e }, msg, new Uint8Array(n.length).fill(0xff)),
    ).toBe(false);
    expect(
      verifyRs256({ n, e: Uint8Array.from([2]) }, msg, parsed.signature),
    ).toBe(false);
  });

  it('needs RSA components', () => {
    const parsed = parseJwt(sign(key, claims()));
    expect(
      kind(() => verifySignature(parsed, { kty: 'RSA', kid: 'test-key-1' })),
    ).toBe('invalid_token');
  });
});

describe('parse', () => {
  it('reads the claims the session carries', () => {
    const p = parseJwt(
      sign(
        key,
        claims({ org_id: 'org_1', role: 'admin', permissions: ['a', 1] }),
      ),
    );
    expect(p.kid).toBe('test-key-1');
    expect(p.claims).toMatchObject({
      sub: 'user_1',
      sid: 'session_1',
      org_id: 'org_1',
      role: 'admin',
      permissions: ['a'],
    });
  });

  it('refuses what is not an RS256 JWT', () => {
    expect(kind(() => parseJwt('a.b'))).toBe('invalid_token');
    expect(kind(() => parseJwt('a.b.c.d'))).toBe('invalid_token');
    expect(kind(() => parseJwt(sign(key, claims(), { alg: 'HS256' })))).toBe(
      'invalid_token',
    );
    expect(kind(() => parseJwt(sign(key, claims(), { alg: 'none' })))).toBe(
      'invalid_token',
    );
    expect(kind(() => parseJwt(sign(key, { sub: 'x' })))).toBe('invalid_token');
    expect(kind(() => parseJwt('!!.e30.e30'))).toBe('invalid_token');
  });
});

describe('findKey', () => {
  const jwks = { keys: [key.jwk, other.jwk, { kty: 'EC', kid: 'ec' }] };
  it('picks by kid, or the only RSA key without one', () => {
    expect(findKey(jwks, 'other')).toBe(other.jwk);
    expect(findKey(jwks, 'ec')).toBeNull();
    expect(findKey(jwks, 'missing')).toBeNull();
    expect(findKey(jwks, null)).toBeNull();
    expect(findKey({ keys: [key.jwk] }, null)).toBe(key.jwk);
  });
});

describe('claims', () => {
  const c = (over: Partial<Claims> = {}): Claims => ({
    sub: 'user_1',
    iss: API,
    exp: NOW_S + 300,
    ...over,
  });
  const check = (cl: Claims, sub = 'user_1') =>
    kind(() => checkClaims(cl, [API], CLIENT_ID, sub, NOW_S));

  it('accepts the API issuer and its per-client form', () => {
    expect(check(c())).toBeNull();
    expect(check(c({ iss: `${API}/` }))).toBeNull();
    expect(check(c({ iss: `${API}/user_management/client_env` }))).toBeNull();
  });

  it('refuses other issuers', () => {
    expect(check(c({ iss: 'https://evil.test' }))).toBe('invalid_token');
    expect(check(c({ iss: `${API}/user_management/notclient` }))).toBe(
      'invalid_token',
    );
    expect(check(c({ iss: `${API}/user_management/client_a/b` }))).toBe(
      'invalid_token',
    );
    expect(check(c({ iss: undefined }))).toBe('invalid_token');
  });

  it('allows 60 s of skew on exp', () => {
    expect(check(c({ exp: NOW_S - 59 }))).toBeNull();
    expect(check(c({ exp: NOW_S - 61 }))).toBe('invalid_token');
  });

  it('checks client_id against ours or the issuer’s', () => {
    expect(check(c({ client_id: CLIENT_ID }))).toBeNull();
    expect(
      check(
        c({
          iss: `${API}/user_management/client_env`,
          client_id: 'client_env',
        }),
      ),
    ).toBeNull();
    expect(check(c({ client_id: 'client_other' }))).toBe('invalid_token');
  });

  it('checks the subject', () => {
    expect(check(c(), 'user_2')).toBe('invalid_token');
  });
});
