import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  base64UrlDecode,
  base64UrlEncode,
  formEncode,
  utf8Decode,
  utf8Encode,
} from '../src/auth/encoding';
import {
  challengeFor,
  parseCallback,
  randomToken,
  startAttempt,
} from '../src/auth/pkce';

const random = (n: number) => new Uint8Array(randomBytes(n));

describe('encoding', () => {
  it('base64url round-trips and matches Node', () => {
    for (let len = 0; len < 40; len++) {
      const bytes = random(len);
      const enc = base64UrlEncode(bytes);
      expect(enc).toBe(Buffer.from(bytes).toString('base64url'));
      expect(base64UrlDecode(enc)).toEqual(bytes);
    }
  });

  it('rejects non-base64url input', () => {
    expect(() => base64UrlDecode('ab+c')).toThrow();
    expect(() => base64UrlDecode('abc=')).toThrow();
    expect(() => base64UrlDecode('a')).toThrow();
  });

  it('utf-8 round-trips and replaces malformed bytes', () => {
    const text = 'Ада 🚀 é ✓';
    expect(utf8Encode(text)).toEqual(new Uint8Array(Buffer.from(text, 'utf8')));
    expect(utf8Decode(utf8Encode(text))).toBe(text);
    expect(utf8Decode(Uint8Array.from([0x61, 0xff, 0x62]))).toBe('a�b');
    expect(utf8Decode(Uint8Array.from([0xe2, 0x82]))).toBe('��');
  });

  it('form-encodes like a browser', () => {
    expect(formEncode({ a: 'x y', 'b&': '=/' })).toBe('a=x%20y&b%26=%3D%2F');
  });
});

describe('pkce', () => {
  it('matches the RFC 7636 appendix B example', () => {
    expect(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('makes valid, fresh verifiers', () => {
    const a = randomToken(random);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken(random)).not.toBe(a);
    expect(() => randomToken(() => new Uint8Array(0))).toThrow();
  });

  it('builds the hosted AuthKit URL', () => {
    const a = startAttempt({
      apiBase: 'https://api.workos.com/',
      clientId: 'client_1',
      redirectUri: 'theodore://callback',
      random,
      loginHint: '  a@b.c ',
    });
    const u = new URL(a.url);
    expect(`${u.origin}${u.pathname}`).toBe(
      'https://api.workos.com/user_management/authorize',
    );
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'client_1',
      redirect_uri: 'theodore://callback',
      provider: 'authkit',
      state: a.state,
      code_challenge: challengeFor(a.verifier),
      code_challenge_method: 'S256',
      login_hint: 'a@b.c',
    });
    expect(a.state).not.toBe(a.verifier);
    expect(a.redirectUri).toBe('theodore://callback');
  });

  it('leaves out an empty login hint', () => {
    const a = startAttempt({
      apiBase: 'https://api.workos.com',
      clientId: 'c',
      redirectUri: 'https://app.test/callback',
      random,
      loginHint: ' ',
    });
    expect(new URL(a.url).searchParams.has('login_hint')).toBe(false);
  });

  it('reads the redirect only for its own state', () => {
    const s = 'state_1';
    expect(parseCallback(`theodore://callback?code=abc&state=${s}`, s)).toEqual(
      {
        kind: 'code',
        code: 'abc',
      },
    );
    expect(
      parseCallback(`https://x.test/callback?state=${s}&code=a%2Bb#frag`, s),
    ).toEqual({ kind: 'code', code: 'a+b' });
    expect(
      parseCallback('theodore://callback?code=abc&state=other', s),
    ).toEqual({
      kind: 'mismatch',
    });
    expect(parseCallback('theodore://callback?code=abc', s)).toEqual({
      kind: 'mismatch',
    });
    expect(
      parseCallback(
        `theodore://callback?error=access_denied&error_description=no+thanks&state=${s}`,
        s,
      ),
    ).toEqual({
      kind: 'error',
      error: 'access_denied',
      description: 'no thanks',
    });
    expect(parseCallback(`theodore://callback?state=${s}`, s).kind).toBe(
      'error',
    );
  });
});
