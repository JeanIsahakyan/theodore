import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import {
  BlobError,
  blobKey,
  chunkAad,
  chunkCount,
  chunkNonce,
  generatedPlaintext,
  openBlob,
  openerFromSeed,
  safeAttachmentName,
  sealBlob,
  validateBlobRef,
  x25519PublicFromEd25519,
  x25519SecretFromEd25519Seed,
} from '../src/fleet/blob';
import type { BlobRef } from '../src/gen/fleet';
import vectors from '../src/gen/fleet-vectors.json';
import { fromBase64, toBase64 } from '../src/keys/base64';
import { seedKey } from '../src/keys/ed25519';

const V = vectors.blobs;
const seed = fromBase64(V.recipient.seed_b64)!;
const recipientPk = V.recipient.public_key;
const hex = (b: Uint8Array) =>
  [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

describe('blob crypto against the Rust vectors', () => {
  it('derives the recipient X25519 keys from the ed25519 key', () => {
    expect(toBase64(x25519SecretFromEd25519Seed(seed))).toBe(
      V.recipient.x25519_secret_b64,
    );
    const pk = fromBase64(recipientPk)!;
    expect(toBase64(x25519PublicFromEd25519(pk)!)).toBe(
      V.recipient.x25519_public_key_b64,
    );
    expect(toBase64(openerFromSeed(seed).x25519PublicKey)).toBe(
      V.recipient.x25519_public_key_b64,
    );
    expect(seedKey(seed).publicKey).toBe(recipientPk);
  });

  it('refuses a public key that is not on the curve', () => {
    expect(x25519PublicFromEd25519(new Uint8Array(32).fill(0xff))).toBeNull();
    expect(x25519PublicFromEd25519(new Uint8Array(31))).toBeNull();
    expect(() =>
      sealBlob(
        toBase64(new Uint8Array(32).fill(0xff)),
        new Uint8Array(1),
        'a',
        'b',
      ),
    ).toThrow(BlobError);
  });

  for (const c of V.cases) {
    it(`seals "${c.title}" byte for byte`, () => {
      const plaintext = generatedPlaintext(c.plaintext.size);
      const { ref, chunks } = sealBlob(
        recipientPk,
        plaintext,
        c.ref.name,
        c.ref.mime,
        {
          blobId: c.ref.blob_id,
          ephSk: fromBase64(c.eph_secret_b64)!,
          noncePrefix: fromBase64(c.ref.nonce_prefix)!,
        },
      );
      expect(ref).toEqual(c.ref);
      expect(ref.eph_pk).toBe(c.eph_public_key_b64);
      const ephPk = fromBase64(c.eph_public_key_b64)!;
      const opener = openerFromSeed(seed);
      expect(
        toBase64(
          blobKey(opener.sharedSecret(ephPk), ephPk, opener.x25519PublicKey),
        ),
      ).toBe(c.key_b64);
      expect(chunks).toHaveLength(c.chunks.length);
      c.chunks.forEach((want, i) => {
        expect(hex(chunkAad(ref.blob_id, i, ref.chunks))).toBe(want.aad_hex);
        expect(toBase64(chunkNonce(fromBase64(ref.nonce_prefix)!, i))).toBe(
          want.nonce_b64,
        );
        expect(chunks[i]!.length).toBe(want.ciphertext_len);
        expect(hex(sha256(chunks[i]!))).toBe(want.ciphertext_sha256);
      });
      expect(openBlob(seed, ref, chunks)).toEqual(plaintext);
      expect(openBlob(opener, ref, chunks)).toEqual(plaintext);
    });
  }

  it('counts chunks like Rust', () => {
    expect(V.chunk_bytes).toBe(4 * 1024 * 1024);
    expect(chunkCount(0)).toBe(1);
    expect(chunkCount(1)).toBe(1);
    expect(chunkCount(V.chunk_bytes)).toBe(1);
    expect(chunkCount(V.chunk_bytes + 1)).toBe(2);
  });
});

describe('seal and open', () => {
  const bytes = new TextEncoder().encode('hello, file');
  const sealed = () =>
    sealBlob(recipientPk, bytes, 'notes/hello.txt', 'text/plain');

  it('round-trips with random parameters and a safe name', () => {
    const { ref, chunks } = sealed();
    expect(ref.name).toBe('hello.txt');
    expect(ref.size).toBe(bytes.length);
    expect(ref.chunks).toBe(1);
    expect(validateBlobRef(ref)).toBeNull();
    expect(openBlob(seed, ref, chunks)).toEqual(bytes);
    // Another seal of the same bytes: new id, key and nonce.
    expect(sealed().ref.blob_id).not.toBe(ref.blob_id);
  });

  it('fails for the wrong recipient', () => {
    const { ref, chunks } = sealed();
    const other = new Uint8Array(32).fill(7);
    expect(() => openBlob(other, ref, chunks)).toThrow(/chunk 0/);
  });

  it('fails on a tampered, swapped, dropped or renamed chunk', () => {
    const big = generatedPlaintext(V.chunk_bytes + 3);
    const { ref, chunks } = sealBlob(recipientPk, big, 'big.bin', '');
    expect(chunks).toHaveLength(2);
    const flipped = Uint8Array.from(chunks[1]!);
    flipped[0]! ^= 1;
    expect(() => openBlob(seed, ref, [chunks[0]!, flipped])).toThrow(/chunk 1/);
    expect(() => openBlob(seed, ref, [chunks[1]!, chunks[0]!])).toThrow(
      /chunk 0/,
    );
    expect(() => openBlob(seed, ref, [chunks[0]!])).toThrow(/expected 2/);
    expect(() =>
      openBlob(seed, { ...ref, blob_id: 'a'.repeat(32) }, chunks),
    ).toThrow(/chunk 0/);
    expect(() =>
      openBlob(seed, { ...ref, sha256: '0'.repeat(64) }, chunks),
    ).toThrow(/doesn't match/);
    expect(() =>
      openBlob(seed, { ...ref, size: 5, chunks: 1 }, [chunks[0]!]),
    ).toThrow(BlobError);
  });

  it('refuses an oversized chunk before decrypting it', () => {
    const { ref } = sealed();
    const huge = new Uint8Array(V.chunk_bytes + 17);
    expect(() => openBlob(seed, ref, [huge])).toThrow(/chunk 0/);
  });
});

describe('validateBlobRef', () => {
  const good: BlobRef = V.cases[1]!.ref;
  it('accepts the vectors', () => {
    for (const c of V.cases) expect(validateBlobRef(c.ref)).toBeNull();
  });
  it.each<[string, Partial<BlobRef>]>([
    ['blob_id', { blob_id: 'ABC' }],
    ['blob_id', { blob_id: 'G'.repeat(32) }],
    ['name', { name: '' }],
    ['name', { name: 'a/b' }],
    ['name', { name: 'x'.repeat(201) }],
    ['mime', { mime: 'a\nb' }],
    ['chunks', { chunks: 0 }],
    ['chunks', { chunks: 2 }],
    ['chunks', { size: -1 }],
    ['sha256', { sha256: 'xyz' }],
    ['eph_pk', { eph_pk: 'AAAA' }],
    ['nonce_prefix', { nonce_prefix: 'AAAA' }],
  ])('names the bad field: %s', (field, patch) => {
    expect(validateBlobRef({ ...good, ...patch })).toBe(field);
  });
  it('refuses what is not an object', () => {
    expect(validateBlobRef(null)).toBe('ref');
    expect(validateBlobRef('x')).toBe('ref');
  });
});

describe('safeAttachmentName', () => {
  it('keeps the last component, drops dots and control characters', () => {
    expect(safeAttachmentName('a/b/c.txt')).toBe('c.txt');
    expect(safeAttachmentName('a\\b\\c.txt')).toBe('c.txt');
    expect(safeAttachmentName('..')).toBe('file');
    expect(safeAttachmentName('.hidden')).toBe('hidden');
    expect(safeAttachmentName('  x\u0000y.png ')).toBe('xy.png');
    expect(safeAttachmentName('dir/')).toBe('dir');
    expect(safeAttachmentName('')).toBe('file');
  });
  it('cuts a long name and keeps a short extension', () => {
    const long = `${'a'.repeat(250)}.png`;
    const cut = safeAttachmentName(long);
    expect([...cut].length).toBe(200);
    expect(cut.endsWith('.png')).toBe(true);
    const noExt = safeAttachmentName('b'.repeat(250));
    expect([...noExt].length).toBe(200);
  });
});
