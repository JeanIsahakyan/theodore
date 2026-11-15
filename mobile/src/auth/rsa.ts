/**
 * RS256 verification (RSASSA-PKCS1-v1_5 with SHA-256, RFC 8017 §8.2.2) in
 * plain TypeScript: BigInt for the public-key operation, `@noble/hashes`
 * for SHA-256. Hermes has no WebCrypto `subtle`, so `jose` can't verify
 * there; this runs the same on Hermes, the web and Node (tests).
 *
 * Verification only, public inputs only: no constant-time needs. Key sizes
 * as `ring`'s RSA_PKCS1_2048_8192_SHA256 (the desktop): 2048..=8192 bits.
 */
import { sha256 } from '@noble/hashes/sha2.js';

/** DER of DigestInfo{sha256, NULL} followed by the 32-byte hash. */
const SHA256_PREFIX = Uint8Array.from([
  0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04,
  0x02, 0x01, 0x05, 0x00, 0x04, 0x20,
]);

function toBigInt(bytes: Uint8Array): bigint {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex ? BigInt(`0x${hex}`) : 0n;
}

function toBytes(n: bigint, length: number): Uint8Array | null {
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  if (hex.length / 2 > length) return null;
  const out = new Uint8Array(length);
  const offset = length - hex.length / 2;
  for (let i = 0; i < hex.length / 2; i++) {
    out[offset + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

function bitLength(n: bigint): number {
  return n === 0n ? 0 : n.toString(2).length;
}

/**
 * True when `signature` is a valid RS256 signature of `message` under the
 * public key (`n`, `e` as big-endian bytes, the JWK's decoded fields).
 */
export function verifyRs256(
  key: { n: Uint8Array; e: Uint8Array },
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  const n = toBigInt(key.n);
  const e = toBigInt(key.e);
  const bits = bitLength(n);
  if (bits < 2048 || bits > 8192 || (n & 1n) === 0n) return false;
  if (e < 3n || (e & 1n) === 0n || bitLength(e) > 33) return false;
  const k = Math.ceil(bits / 8);
  if (signature.length !== k) return false;
  const s = toBigInt(signature);
  if (s >= n) return false;
  const em = toBytes(modPow(s, e, n), k);
  if (!em) return false;

  const hash = sha256(message);
  const tLen = SHA256_PREFIX.length + hash.length;
  const psLen = k - 3 - tLen;
  if (psLen < 8) return false;
  const expected = new Uint8Array(k);
  expected[0] = 0x00;
  expected[1] = 0x01;
  expected.fill(0xff, 2, 2 + psLen);
  expected[2 + psLen] = 0x00;
  expected.set(SHA256_PREFIX, 3 + psLen);
  expected.set(hash, 3 + psLen + SHA256_PREFIX.length);

  let diff = 0;
  for (let i = 0; i < k; i++) diff |= em[i] ^ expected[i];
  return diff === 0;
}
