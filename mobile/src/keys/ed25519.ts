/**
 * ed25519 with `@noble/ed25519` (pure JS, audited), synchronous SHA-512
 * from `@noble/hashes` so it runs where WebCrypto doesn't (Hermes).
 */
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { fromBase64, toBase64 } from './base64';
import type { DeviceKey } from './types';

ed.hashes.sha512 = sha512;

export const SEED_BYTES = 32;

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
