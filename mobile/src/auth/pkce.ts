/**
 * PKCE (RFC 7636, S256 only), the `state` CSRF token, the hosted AuthKit
 * URL and the redirect it comes back with. Pure: randomness is passed in.
 * Mirrors `crates/account-workos/src/pkce.rs` and `authorize_url`.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { base64UrlEncode, utf8Encode } from './encoding';

export type RandomBytes = (length: number) => Uint8Array;

/** 32 random bytes, base64url: 43 chars, inside RFC 7636's 43..=128. */
export function randomToken(random: RandomBytes): string {
  const bytes = random(32);
  if (bytes.length !== 32) throw new Error('no randomness');
  return base64UrlEncode(bytes);
}

export const trimSlash = (s: string) => s.trim().replace(/\/+$/, '');

export function challengeFor(verifier: string): string {
  return base64UrlEncode(sha256(utf8Encode(verifier)));
}

export interface SignInAttempt {
  url: string;
  state: string;
  verifier: string;
  redirectUri: string;
}

/** A fresh verifier and state, and the hosted sign-in page for them. */
export function startAttempt(opts: {
  apiBase: string;
  clientId: string;
  redirectUri: string;
  random: RandomBytes;
  loginHint?: string | null;
}): SignInAttempt {
  const verifier = randomToken(opts.random);
  const state = randomToken(opts.random);
  const q: [string, string][] = [
    ['response_type', 'code'],
    ['client_id', opts.clientId],
    ['redirect_uri', opts.redirectUri],
    ['provider', 'authkit'],
    ['state', state],
    ['code_challenge', challengeFor(verifier)],
    ['code_challenge_method', 'S256'],
  ];
  const hint = opts.loginHint?.trim();
  if (hint) q.push(['login_hint', hint]);
  const query = q
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return {
    url: `${trimSlash(opts.apiBase)}/user_management/authorize?${query}`,
    state,
    verifier,
    redirectUri: opts.redirectUri,
  };
}

export type CallbackResult =
  | { kind: 'code'; code: string }
  | { kind: 'error'; error: string; description: string }
  /** No or another `state`: not this attempt's answer (CSRF), ignore it. */
  | { kind: 'mismatch' };

function queryParams(url: string): Map<string, string> {
  const params = new Map<string, string>();
  const q = url.indexOf('?');
  if (q < 0) return params;
  const hash = url.indexOf('#', q);
  const query = url.slice(q + 1, hash < 0 ? undefined : hash);
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const decode = (s: string) => {
      try {
        return decodeURIComponent(s.replace(/\+/g, ' '));
      } catch {
        return s;
      }
    };
    const key = decode(eq < 0 ? pair : pair.slice(0, eq));
    if (!params.has(key))
      params.set(key, eq < 0 ? '' : decode(pair.slice(eq + 1)));
  }
  return params;
}

/** The redirect `…/callback?code&state` (or `?error`) for `state`. */
export function parseCallback(url: string, state: string): CallbackResult {
  const p = queryParams(url);
  if (!p.get('state') || p.get('state') !== state) return { kind: 'mismatch' };
  const error = p.get('error');
  if (error) {
    return {
      kind: 'error',
      error,
      description: (p.get('error_description') ?? '').slice(0, 200),
    };
  }
  const code = p.get('code');
  if (!code) {
    return {
      kind: 'error',
      error: 'no_code',
      description: 'the sign-in came back without a code',
    };
  }
  return { kind: 'code', code };
}
