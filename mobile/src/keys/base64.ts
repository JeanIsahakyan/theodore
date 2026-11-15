/**
 * Base64 (standard alphabet, padded), as Rust's `base64::STANDARD` reads and
 * writes it: how keys, nonces and signatures travel. No `Buffer`/`atob`, so
 * it behaves the same on Hermes, browsers and Node.
 */
const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Map<string, number>(
  [...ALPHABET].map((c, i) => [c, i] as const),
);

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    const n = (a << 16) | (b << 8) | c;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!;
    out += i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63]! : '=';
    out += i + 2 < bytes.length ? ALPHABET[n & 63]! : '=';
  }
  return out;
}

/**
 * Strict: padded to a multiple of 4, padding only at the end, unused bits
 * zero (like Rust's decoder). `null` for anything else.
 */
export function fromBase64(s: string): Uint8Array | null {
  if (s.length % 4 !== 0) return null;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const body = s.length - pad;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (let i = 0; i < body; i++) {
    const v = LOOKUP.get(s[i]!);
    if (v === undefined) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
      acc &= (1 << bits) - 1;
    }
  }
  // Leftover bits must be zero (canonical encoding).
  if (acc !== 0) return null;
  return out;
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
