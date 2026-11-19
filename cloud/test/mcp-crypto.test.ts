// The MCP device signs byte for byte as the Rust crate (its vectors), and
// its private key opens only for the row it was wrapped for.
import { describe, expect, it } from 'vitest';
import vectors from '../src/gen/fleet-vectors.json';
import type { RemoteRequest } from '../src/gen/fleet';
import { b64, unb64 } from '../src/fleet/wire';
import {
  fingerprint,
  newDeviceKey,
  normalizeFingerprint,
  requestBody,
  signFor,
  unwrapPrivateKey,
  wrapPrivateKey,
} from '../src/mcp/crypto';
import { MCP_TEST_SECRET } from './fleet-harness';

/** PKCS#8 for an Ed25519 seed (RFC 8410's fixed prefix). */
function pkcs8Of(seed: Uint8Array): Uint8Array {
  const prefix = [
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
    0x04, 0x22, 0x04, 0x20,
  ];
  return Uint8Array.from([...prefix, ...seed]);
}

const seedKey = () =>
  crypto.subtle.importKey(
    'pkcs8',
    pkcs8Of(unb64(vectors.seed_b64)!),
    { name: 'Ed25519' },
    false,
    ['sign'],
  );

describe('signing compat', () => {
  it('writes a request body as serde does', () => {
    const req = JSON.parse(vectors.request.body) as RemoteRequest;
    expect(requestBody(req)).toBe(vectors.request.body);
  });

  it('signs requests and hellos like the Rust vectors', async () => {
    const key = await seedKey();
    expect(
      await signFor(
        key,
        'request',
        new TextEncoder().encode(vectors.request.body),
      ),
    ).toBe(vectors.request.signature);
    expect(await signFor(key, 'hello', unb64(vectors.hello.nonce_b64)!)).toBe(
      vectors.hello.signature,
    );
  });

  it('fingerprints as every device shows it', async () => {
    const f = await fingerprint(vectors.public_key);
    expect(f).toMatch(/^([0-9a-f]{4} ){7}[0-9a-f]{4}$/);
    const d = new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(vectors.public_key),
      ),
    );
    expect(normalizeFingerprint(f)).toBe(
      [...d.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join(''),
    );
  });
});

describe('device key at rest', () => {
  it('opens only for the same org, user and key', async () => {
    const k = await newDeviceKey();
    const bound = { org: 'org_1', user: 'user_1', publicKey: k.publicKey };
    const wrapped = await wrapPrivateKey(MCP_TEST_SECRET, bound, k.pkcs8);
    expect(wrapped).not.toContain(b64(k.pkcs8).slice(0, 20));
    const key = await unwrapPrivateKey(MCP_TEST_SECRET, bound, wrapped);
    expect(await signFor(key, 'hello', new Uint8Array(32))).toMatch(/=$/);
    await expect(
      unwrapPrivateKey(MCP_TEST_SECRET, { ...bound, user: 'user_2' }, wrapped),
    ).rejects.toThrow();
    await expect(
      unwrapPrivateKey(`${MCP_TEST_SECRET}x`, bound, wrapped),
    ).rejects.toThrow();
  });
});
