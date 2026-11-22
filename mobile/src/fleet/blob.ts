/**
 * Files between devices, byte for byte as `crates/fleet-protocol/src/blob.rs`
 * (docs/fleet.md "Files (blobs)"; checked against `fleet-vectors.json`
 * `blobs` in the tests). The cloud stores only ciphertext; the `BlobRef`
 * rides inside a signed request or reply.
 *
 * ```text
 * "theodore-blob-v1"
 * recipient   x25519_pk = Edwards ─▶ Montgomery of the ed25519 pk
 *             x25519_sk = clamp(SHA-512(ed25519 seed)[..32])
 * sender      eph_sk random (per blob) ─▶ eph_pk
 *             shared = X25519(eph_sk, x25519_pk)
 *             key    = HKDF-SHA256(ikm = shared, salt = eph_pk ‖ x25519_pk,
 *                                  info = "theodore-blob-v1", 32)
 * chunk i     XChaCha20-Poly1305(key, nonce = nonce_prefix(16) ‖ u64be(i),
 *                                aad = blob_id ‖ u32be(i) ‖ u32be(chunks))
 * sha256      hex of the whole plaintext, checked after every tag opened
 * ```
 *
 * Opening needs this device's X25519 secret, derived from its ed25519
 * seed. The seed never leaves `src/keys`: a `DeviceKey` made from one
 * exposes a `BlobOpener` (the X25519 public key and a shared-secret
 * function); a WebCrypto key (web) has none and can't open blobs.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import type { BlobRef } from '../gen/fleet';
import { concat, fromBase64, toBase64, utf8 } from '../keys/base64';
import type { BlobOpener } from '../keys/types';

export const BLOB_INFO = 'theodore-blob-v1';
/** Plaintext bytes per chunk, at most. */
export const CHUNK_BYTES = 4 * 1024 * 1024;
/** The Poly1305 tag after every chunk's ciphertext. */
export const TAG_BYTES = 16;
export const NONCE_PREFIX_BYTES = 16;
/** Chunks per blob, at most. */
export const MAX_CHUNKS = 64;
/** Blobs one request carries, at most. */
export const MAX_ATTACHMENTS = 10;
/** One attachment's plaintext, at most. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** What a `read_file` hands back, at most. */
export const MAX_READ_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_NAME_CHARS = 200;
export const MAX_MIME_CHARS = 100;
export const MAX_PATH_CHARS = 1024;
export const BLOB_ID_CHARS = 32;

/** Why a blob couldn't be made or opened (Rust's `BlobError`). */
export class BlobError extends Error {
  constructor(
    readonly kind:
      | 'invalid'
      | 'too_large'
      | 'bad_recipient_key'
      | 'chunk_count'
      | 'tamper'
      | 'digest',
    message: string,
  ) {
    super(message);
    this.name = 'BlobError';
  }
}

/**
 * What a device needs to open blobs sealed for it, without its seed: its
 * X25519 public key and X25519 with its secret. Made by `seedKey`
 * (`src/keys/ed25519.ts`, `DeviceKey.blobOpener`).
 */
export type { BlobOpener } from '../keys/types';

// ── keys ────────────────────────────────────────────────────────────────────

/**
 * The X25519 public key of an ed25519 public key (Edwards ─▶ Montgomery,
 * libsodium's `crypto_sign_ed25519_pk_to_curve25519`); `null` unless the
 * bytes are a point on the curve.
 */
export function x25519PublicFromEd25519(
  ed25519Pk: Uint8Array,
): Uint8Array | null {
  if (ed25519Pk.length !== 32) return null;
  try {
    return ed25519.utils.toMontgomery(ed25519Pk);
  } catch {
    return null;
  }
}

/** X25519 scalar clamping (RFC 7748). */
export function clamp(sk: Uint8Array): Uint8Array {
  const out = Uint8Array.from(sk);
  out[0]! &= 248;
  out[31]! &= 127;
  out[31]! |= 64;
  return out;
}

/**
 * The X25519 secret of an ed25519 seed: SHA-512(seed)[..32], clamped
 * (libsodium's `crypto_sign_ed25519_sk_to_curve25519`).
 */
export function x25519SecretFromEd25519Seed(seed: Uint8Array): Uint8Array {
  if (seed.length !== 32) throw new BlobError('invalid', 'a seed is 32 bytes');
  return clamp(sha512(seed).subarray(0, 32));
}

/** A `BlobOpener` for the device with this ed25519 seed. */
export function openerFromSeed(seed: Uint8Array): BlobOpener {
  const sk = x25519SecretFromEd25519Seed(seed);
  return {
    x25519PublicKey: x25519.getPublicKey(sk),
    sharedSecret: (peer) => x25519.getSharedSecret(sk, peer),
  };
}

/** HKDF-SHA256(shared, salt = eph_pk ‖ recipient_x_pk, info): the blob key. */
export function blobKey(
  shared: Uint8Array,
  ephPk: Uint8Array,
  recipientXPk: Uint8Array,
): Uint8Array {
  return hkdf(sha256, shared, concat(ephPk, recipientXPk), utf8(BLOB_INFO), 32);
}

/** The nonce of chunk `i`: `nonce_prefix ‖ u64be(i)`. */
export function chunkNonce(noncePrefix: Uint8Array, i: number): Uint8Array {
  const n = new Uint8Array(24);
  n.set(noncePrefix, 0);
  const view = new DataView(n.buffer);
  view.setUint32(16, Math.floor(i / 2 ** 32));
  view.setUint32(20, i >>> 0);
  return n;
}

/** The AAD of chunk `i`: `blob_id ‖ u32be(i) ‖ u32be(chunks)`. */
export function chunkAad(
  blobId: string,
  i: number,
  chunks: number,
): Uint8Array {
  const id = utf8(blobId);
  const a = new Uint8Array(id.length + 8);
  a.set(id, 0);
  const view = new DataView(a.buffer);
  view.setUint32(id.length, i >>> 0);
  view.setUint32(id.length + 4, chunks >>> 0);
  return a;
}

/** How many chunks `size` plaintext bytes take (an empty file is one). */
export const chunkCount = (size: number): number =>
  Math.max(1, Math.ceil(size / CHUNK_BYTES));

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** A fresh blob id: 16 random bytes, lowercase hex. */
export const newBlobId = (random: (n: number) => Uint8Array): string =>
  hex(random(16));

// ── seal / open ─────────────────────────────────────────────────────────────

/** What `sealBlob` draws at random; fixed for the test vectors. */
export interface SealParams {
  blobId: string;
  /** Clamped on use (X25519 does), so any 32 bytes do. */
  ephSk: Uint8Array;
  noncePrefix: Uint8Array;
}

export function randomSealParams(
  random: (n: number) => Uint8Array,
): SealParams {
  return {
    blobId: newBlobId(random),
    ephSk: random(32),
    noncePrefix: random(NONCE_PREFIX_BYTES),
  };
}

/**
 * Encrypts `plaintext` for the device whose ed25519 public key (base64,
 * as pinned) is `recipientEd25519Pk`: the reference to put in the request
 * and the ciphertext chunks to PUT in order. `name` goes through
 * `safeAttachmentName`.
 */
export function sealBlob(
  recipientEd25519Pk: string,
  plaintext: Uint8Array,
  name: string,
  mime: string,
  params: SealParams = randomSealParams(randomBytes),
): { ref: BlobRef; chunks: Uint8Array[] } {
  const pk = fromBase64(recipientEd25519Pk);
  const recipient = pk ? x25519PublicFromEd25519(pk) : null;
  if (!recipient)
    throw new BlobError('bad_recipient_key', 'recipient key unusable');
  const chunks = chunkCount(plaintext.length);
  if (chunks > MAX_CHUNKS) throw new BlobError('too_large', 'file too large');
  const ephPk = x25519.getPublicKey(params.ephSk);
  const key = blobKey(
    x25519.getSharedSecret(params.ephSk, recipient),
    ephPk,
    recipient,
  );
  const out: Uint8Array[] = [];
  for (let i = 0; i < chunks; i++) {
    const start = i * CHUNK_BYTES;
    const end = Math.min(start + CHUNK_BYTES, plaintext.length);
    const cipher = xchacha20poly1305(
      key,
      chunkNonce(params.noncePrefix, i),
      chunkAad(params.blobId, i, chunks),
    );
    out.push(cipher.encrypt(plaintext.subarray(start, end)));
  }
  const ref: BlobRef = {
    blob_id: params.blobId,
    name: safeAttachmentName(name),
    mime: [...mime].slice(0, MAX_MIME_CHARS).join(''),
    size: plaintext.length,
    chunks,
    sha256: hex(sha256(plaintext)),
    eph_pk: toBase64(ephPk),
    nonce_prefix: toBase64(params.noncePrefix),
  };
  const bad = validateBlobRef(ref);
  if (bad) throw new BlobError('invalid', `invalid blob reference: ${bad}`);
  return { ref, chunks: out };
}

/**
 * Decrypts a blob sealed for this device (`opener`, or its ed25519 seed):
 * every chunk's tag must open and the plaintext must have the reference's
 * size and SHA-256. Nothing comes back on any failure.
 */
export function openBlob(
  own: BlobOpener | Uint8Array,
  ref: BlobRef,
  chunks: readonly Uint8Array[],
): Uint8Array {
  const bad = validateBlobRef(ref);
  if (bad) throw new BlobError('invalid', `invalid blob reference: ${bad}`);
  if (chunks.length !== ref.chunks) {
    throw new BlobError(
      'chunk_count',
      `expected ${ref.chunks} chunks, got ${chunks.length}`,
    );
  }
  const opener = own instanceof Uint8Array ? openerFromSeed(own) : own;
  const ephPk = fromBase64(ref.eph_pk)!;
  const noncePrefix = fromBase64(ref.nonce_prefix)!;
  const key = blobKey(
    opener.sharedSecret(ephPk),
    ephPk,
    opener.x25519PublicKey,
  );
  const plain = new Uint8Array(ref.size);
  let at = 0;
  for (let i = 0; i < chunks.length; i++) {
    const sealed = chunks[i]!;
    // Bounded before decrypting: a chunk can't be longer than its share
    // plus the tag.
    if (sealed.length > CHUNK_BYTES + TAG_BYTES)
      throw new BlobError('tamper', `chunk ${i} doesn't open`);
    let part: Uint8Array;
    try {
      part = xchacha20poly1305(
        key,
        chunkNonce(noncePrefix, i),
        chunkAad(ref.blob_id, i, ref.chunks),
      ).decrypt(sealed);
    } catch {
      throw new BlobError('tamper', `chunk ${i} doesn't open`);
    }
    if (at + part.length > plain.length)
      throw new BlobError('digest', "plaintext doesn't match the reference");
    plain.set(part, at);
    at += part.length;
  }
  if (at !== ref.size || hex(sha256(plain)) !== ref.sha256)
    throw new BlobError('digest', "plaintext doesn't match the reference");
  return plain;
}

// ── validation ──────────────────────────────────────────────────────────────

const isLowerHex = (s: string): boolean => /^[0-9a-f]*$/.test(s);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Every field within its bounds (Rust's `BlobRef::validate`): the name of
 * the field that isn't, else `null`. The op's size caps (an attachment, a
 * `read_file`) are checked by the op.
 */
export function validateBlobRef(r: unknown): string | null {
  if (!r || typeof r !== 'object') return 'ref';
  const b = r as Record<string, unknown>;
  if (
    typeof b.blob_id !== 'string' ||
    b.blob_id.length !== BLOB_ID_CHARS ||
    !isLowerHex(b.blob_id)
  )
    return 'blob_id';
  if (
    typeof b.name !== 'string' ||
    b.name === '' ||
    [...b.name].length > MAX_NAME_CHARS ||
    /[/\\\u0000]/.test(b.name)
  )
    return 'name';
  if (
    typeof b.mime !== 'string' ||
    [...b.mime].length > MAX_MIME_CHARS ||
    CONTROL.test(b.mime)
  )
    return 'mime';
  if (
    typeof b.size !== 'number' ||
    !Number.isInteger(b.size) ||
    b.size < 0 ||
    typeof b.chunks !== 'number' ||
    !Number.isInteger(b.chunks) ||
    b.chunks < 1 ||
    b.chunks > MAX_CHUNKS ||
    chunkCount(b.size) !== b.chunks
  )
    return 'chunks';
  if (
    typeof b.sha256 !== 'string' ||
    b.sha256.length !== 64 ||
    !isLowerHex(b.sha256)
  )
    return 'sha256';
  if (typeof b.eph_pk !== 'string' || fromBase64(b.eph_pk)?.length !== 32)
    return 'eph_pk';
  if (
    typeof b.nonce_prefix !== 'string' ||
    fromBase64(b.nonce_prefix)?.length !== NONCE_PREFIX_BYTES
  )
    return 'nonce_prefix';
  return null;
}

/** `validateBlobRef` as a type guard. */
export const isBlobRef = (r: unknown): r is BlobRef =>
  validateBlobRef(r) === null;

/**
 * A file name safe to write under a directory (Rust's
 * `safe_attachment_name`): the last path component (both separators),
 * control characters dropped, no leading dots, trimmed, cut to 200
 * characters keeping a short extension; `file` when nothing is left.
 */
export function safeAttachmentName(name: string): string {
  const last =
    name
      .split(/[/\\]/)
      .reverse()
      .find((p) => p.trim() !== '') ?? '';
  const cleaned = [...last]
    .filter((c) => !CONTROL.test(c))
    .join('')
    .trim()
    .replace(/^\.+/, '')
    .trim();
  if (cleaned === '') return 'file';
  const chars = [...cleaned];
  if (chars.length <= MAX_NAME_CHARS) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const rawExt = dot >= 0 ? cleaned.slice(dot + 1) : '';
  const ext =
    rawExt !== '' && [...rawExt].length <= 16 && !rawExt.includes(' ')
      ? `.${rawExt}`
      : '';
  const keep = MAX_NAME_CHARS - [...ext].length;
  return `${chars.slice(0, keep).join('').trimEnd()}${ext}`;
}

/** Random bytes from the runtime's `crypto` (Hermes, browsers, Node). */
export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** The vectors' plaintext generator: byte `i` is `(i × 31) mod 251`. */
export function generatedPlaintext(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31) % 251;
  return out;
}
