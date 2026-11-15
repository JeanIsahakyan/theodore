/**
 * Test-only RSA key and token signing (Node's crypto; generated per run,
 * protects nothing), plus a fake `fetch` for `WorkosApi`.
 */
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { HttpFetch } from '../src/auth/workos';

export const KID = 'test-key-1';
export const CLIENT_ID = 'client_test';
export const API = 'https://api.workos.test';
export const CLOUD = 'https://cloud.test';

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export interface TestKey {
  privateKey: KeyObject;
  jwk: { kty: string; kid: string; n: string; e: string };
}

export function makeKey(bits = 2048, kid = KID): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: bits,
  });
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  return { privateKey, jwk: { kty: 'RSA', kid, n: jwk.n, e: jwk.e } };
}

export function sign(
  key: TestKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {
    alg: 'RS256',
    typ: 'JWT',
    kid: key.jwk.kid,
  },
): string {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const s = createSign('RSA-SHA256');
  s.update(input);
  return `${input}.${b64url(s.sign(key.privateKey))}`;
}

export const NOW_S = 1_800_000_000;

export function claims(over: Record<string, unknown> = {}) {
  return {
    iss: API,
    sub: 'user_1',
    exp: NOW_S + 300,
    sid: 'session_1',
    ...over,
  };
}

export function authBody(
  key: TestKey,
  over: {
    claims?: Record<string, unknown>;
    organization_id?: string | null;
    refresh_token?: string;
  } = {},
): string {
  return JSON.stringify({
    user: { id: 'user_1', email: 'a@b.c', first_name: 'Ada', last_name: 'L' },
    organization_id: over.organization_id ?? undefined,
    access_token: sign(key, claims(over.claims)),
    refresh_token: over.refresh_token ?? 'refresh_2',
  });
}

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

type Handler = (call: Call) => { status: number; body: string } | Error;

/** Routes by `METHOD path` (no origin, no query); records every call. */
export function fakeFetch(routes: Record<string, Handler>): HttpFetch & {
  calls: Call[];
} {
  const calls: Call[] = [];
  const f = (async (url, init) => {
    const call = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
    };
    calls.push(call);
    const u = new URL(url);
    const handler = routes[`${init.method} ${u.origin}${u.pathname}`];
    if (!handler) throw new TypeError(`no route for ${init.method} ${url}`);
    const r = handler(call);
    if (r instanceof Error) throw r;
    return { status: r.status, text: async () => r.body };
  }) as HttpFetch & { calls: Call[] };
  f.calls = calls;
  return f;
}

/** The fields of a WorkOS `authenticate` call (sent as JSON). */
export const form = (body: string | undefined) =>
  JSON.parse(body ?? '{}') as Record<string, string>;
