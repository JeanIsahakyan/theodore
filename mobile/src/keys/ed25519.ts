/**
 * ed25519 with `@noble/ed25519` (pure JS, audited), synchronous SHA-512
 * from `@noble/hashes` so it runs where WebCrypto doesn't (Hermes). The
 * X25519 side of a seed key (opening blobs, docs/fleet.md "Files (blobs)")
 * is `@noble/curves`, derived as libsodium does.
 */
import * as ed from '@noble/ed25519';
import { x25519 } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { fromBase64, toBase64 } from './base64';
import type { BlobOpener, DeviceKey } from './types';

ed.hashes.sha512 = sha512;

export const SEED_BYTES = 32;

/** X25519 scalar clamping (RFC 7748). */
function clamp(sk: Uint8Array): Uint8Array {
  sk[0]! &= 248;
  sk[31]! &= 127;
  sk[31]! |= 64;
  return sk;
}

/**
 * The X25519 secret of an ed25519 seed (SHA-512(seed)[..32], clamped:
 * libsodium's `crypto_sign_ed25519_sk_to_curve25519`), kept in this
 * closure: callers get the public key and a shared-secret function only.
 */
function blobOpener(seed: Uint8Array): BlobOpener {
  const sk = clamp(sha512(seed).slice(0, 32));
  return {
    x25519PublicKey: x25519.getPublicKey(sk),
    sharedSecret: (peer) => x25519.getSharedSecret(sk, peer),
  };
}

/** A device key from a 32-byte seed (the RFC 8032 secret key). */
export function seedKey(seed: Uint8Array): DeviceKey {
  if (seed.length !== SEED_BYTES) {
    throw new Error('a device key seed is 32 bytes');
  }
  const secret = Uint8Array.from(seed);
  const publicKey = toBase64(ed.getPublicKey(secret));
  return {
    publicKey,
    sign: async (message) => toBase64(ed.sign(message, secret)),
    blobOpener: blobOpener(secret),
  };
}

/** Checks a base64 signature over `message` against a base64 public key. */
export function verifySignature(
  publicKey: string,
  message: Uint8Array,
  signature: string,
): boolean {
  const pk = fromBase64(publicKey);
  const sig = fromBase64(signature);
  if (!pk || pk.length !== 32 || !sig || sig.length !== 64) return false;
  try {
    // RFC 8032 rules (not ZIP 215), like ring on the desktop.
    return ed.verify(sig, message, pk, { zip215: false });
  } catch {
    return false;
  }
}

/** Whether `publicKey` is base64 of 32 bytes. */
export function wellFormedKey(publicKey: string): boolean {
  return fromBase64(publicKey)?.length === 32;
}
