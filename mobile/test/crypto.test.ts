import { describe, expect, it } from 'vitest';
import {
  TAGS,
  domainMessage,
  open,
  requestBody,
  seal,
  signHello,
} from '../src/fleet/crypto';
import type { RemoteRequest, SignedEnvelope } from '../src/gen/fleet';
import vectors from '../src/gen/fleet-vectors.json';
import { fromBase64, toBase64, utf8 } from '../src/keys/base64';
import { seedKey, verifySignature } from '../src/keys/ed25519';
import { fingerprint } from '../src/keys/fingerprint';
import {
  generateWebKey,
  webDeviceKey,
  webEd25519Supported,
} from '../src/keys/webcrypto';

const seed = fromBase64(vectors.seed_b64)!;
const key = seedKey(seed);

describe('fleet crypto against the Rust vectors', () => {
  it('has every domain tag, byte for byte', () => {
    expect(TAGS).toEqual(vectors.tags);
    for (const [k, tag] of Object.entries(TAGS)) {
      expect(tag.endsWith('\0')).toBe(true);
      expect(tag).toBe(`theodore-fleet-${k}-v3\0`);
    }
  });

  it('derives the same public key from the seed', () => {
    expect(seed.length).toBe(32);
    expect(key.publicKey).toBe(vectors.public_key);
  });

  it('signs the hello nonce like Rust', async () => {
    expect(await signHello(key, vectors.hello.nonce_b64)).toBe(
      vectors.hello.signature,
    );
  });

  it('signs a hello nonce only when it is exactly 32 bytes', async () => {
    expect(await signHello(key, toBase64(new Uint8Array(31)))).toBeNull();
    expect(await signHello(key, toBase64(new Uint8Array(33)))).toBeNull();
    expect(await signHello(key, 'not base64!')).toBeNull();
    expect(await signHello(key, vectors.hello.nonce_b64.slice(1))).toBeNull();
  });

  it('seals the request vector: same body text and signature', async () => {
    const req = JSON.parse(vectors.request.body) as RemoteRequest;
    expect(requestBody(req)).toBe(vectors.request.body);
    const env = await seal(req, key);
    expect(env.body).toBe(vectors.request.body);
    expect(env.signature).toBe(vectors.request.signature);
    expect(env.device_id).toBe(req.origin_device);
  });

  it('writes absent options as null, in Rust field order', () => {
    const body = requestBody({
      req_id: 'r',
      origin_device: 'o',
      target_device: 't',
      target_key: 'k',
      issued_at_ms: 1,
      op: {
        op: 'start_space',
        space: 'rs_x',
        project_id: 'p',
        goal: 'g',
        mode: 'ask',
        depth: 0,
      },
    });
    expect(body).toBe(
      '{"req_id":"r","origin_device":"o","target_device":"t","target_key":"k",' +
        '"issued_at_ms":1,"op":{"op":"start_space","space":"rs_x","project_id":"p",' +
        '"goal":"g","mode":"ask","agent":null,"model":null,"effort":null,"parent":null,"depth":0,' +
        '"attachments":[]}}',
    );
  });

  it('verifies the Rust signature of the request', () => {
    expect(
      verifySignature(
        vectors.public_key,
        domainMessage('request', utf8(vectors.request.body)),
        vectors.request.signature,
      ),
    ).toBe(true);
  });
});

describe('open', () => {
  const env: SignedEnvelope = {
    device_id: 'dev_00000000-0000-4000-8000-000000000001',
    body: vectors.request.body,
    signature: vectors.request.signature,
  };

  it('opens the vector request with its key and domain', () => {
    const body = open(env, vectors.public_key, 'request');
    expect(body?.req_id).toBe('req_vector');
    expect(body?.op).toEqual({
      op: 'send',
      space: 'rs_vector',
      text: 'hello',
      mode: 'edit',
      agent: 'claude',
      model: 'opus',
      effort: 'high',
      attachments: [],
    });
  });

  it('rejects another domain', () => {
    expect(open(env, vectors.public_key, 'reply')).toBeNull();
    expect(open(env, vectors.public_key, 'event')).toBeNull();
    expect(open(env, vectors.public_key, 'delegate')).toBeNull();
  });

  it('rejects another key', () => {
    const other = seedKey(new Uint8Array(32).fill(8)).publicKey;
    expect(open(env, other, 'request')).toBeNull();
    expect(open(env, 'garbage', 'request')).toBeNull();
  });

  it('rejects an envelope whose device is not the body signer', () => {
    expect(
      open(
        { ...env, device_id: 'dev_00000000-0000-4000-8000-000000000002' },
        vectors.public_key,
        'request',
      ),
    ).toBeNull();
  });

  it('rejects an altered body', () => {
    expect(
      open(
        { ...env, body: env.body.replace('hello', 'hellO') },
        vectors.public_key,
        'request',
      ),
    ).toBeNull();
  });

  it('opens a body sealed for each domain only in that domain', async () => {
    const body = JSON.stringify({
      space: 'rs_1',
      seq: 1,
      host_device: 'dev_h',
      event: { kind: 'status', status: 'idle' },
    });
    const signature = await key.sign(domainMessage('event', utf8(body)));
    const ev = { device_id: 'dev_h', body, signature };
    expect(open(ev, key.publicKey, 'event')?.seq).toBe(1);
    expect(open(ev, key.publicKey, 'ask')).toBeNull();
  });
});

describe('fingerprint', () => {
  it('is 8 groups of 4 lowercase hex', () => {
    expect(fingerprint(vectors.public_key)).toMatch(
      /^[0-9a-f]{4}( [0-9a-f]{4}){7}$/,
    );
  });

  it('hashes the base64 text (SHA-256 of "abc")', () => {
    // sha256("abc") = ba7816bf8f01cfea414140de5dae2223…
    expect(fingerprint('abc')).toBe('ba78 16bf 8f01 cfea 4141 40de 5dae 2223');
  });
});

describe('base64', () => {
  it('round-trips and is strict', () => {
    for (let n = 0; n < 10; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => i * 37);
      expect(fromBase64(toBase64(b))).toEqual(b);
    }
    expect(fromBase64('abc')).toBeNull();
    expect(fromBase64('ab=c')).toBeNull();
    expect(fromBase64('QR==')).toBeNull(); // non-zero trailing bits
  });
});

describe('web key (WebCrypto Ed25519)', () => {
  it('signs with a non-extractable key that noble verifies', async () => {
    const subtle = globalThis.crypto.subtle;
    expect(await webEd25519Supported(subtle)).toBe(true);
    expect(await webEd25519Supported(undefined)).toBe(false);
    const rec = await generateWebKey(subtle);
    expect(rec.privateKey.extractable).toBe(false);
    expect(fromBase64(rec.publicKey)?.length).toBe(32);
    const sig = await signHello(
      webDeviceKey(subtle, rec),
      vectors.hello.nonce_b64,
    );
    expect(
      verifySignature(
        rec.publicKey,
        domainMessage('hello', fromBase64(vectors.hello.nonce_b64)!),
        sig!,
      ),
    ).toBe(true);
  });
});
