/**
 * base64url and UTF-8 without relying on `atob`, `btoa` or `TextDecoder`
 * (not every Hermes build has them). Pure; used by PKCE and the JWT checks.
 */

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const LOOKUP: Record<string, number> = Object.fromEntries(
  [...ALPHABET].map((c, i) => [c, i]),
);

/** base64url without padding (RFC 4648 §5). */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      ALPHABET[(n >> 18) & 63] +
      ALPHABET[(n >> 12) & 63] +
      ALPHABET[(n >> 6) & 63] +
      ALPHABET[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out +=
      ALPHABET[(n >> 18) & 63] +
      ALPHABET[(n >> 12) & 63] +
      ALPHABET[(n >> 6) & 63];
  }
  return out;
}

/** Strict base64url (no padding, no standard-alphabet chars); throws. */
export function base64UrlDecode(text: string): Uint8Array {
  if (text.length % 4 === 1) throw new Error('bad base64url length');
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (const c of text) {
    const v = LOOKUP[c];
    if (v === undefined) throw new Error('bad base64url character');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    let cp = ch.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd; // lone surrogate
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000)
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63),
        0x80 | (cp & 63),
      );
  }
  return Uint8Array.from(out);
}

/** UTF-8 to string; malformed sequences become U+FFFD. */
export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    let cp = 0xfffd;
    let len = 1;
    if (b < 0x80) cp = b;
    else if (b >= 0xc2 && b < 0xe0) len = 2;
    else if (b >= 0xe0 && b < 0xf0) len = 3;
    else if (b >= 0xf0 && b < 0xf5) len = 4;
    if (len > 1) {
      let v = b & (0xff >> (len + 1));
      let ok = i + len <= bytes.length;
      for (let k = 1; ok && k < len; k++) {
        const c = bytes[i + k];
        if ((c & 0xc0) !== 0x80) ok = false;
        else v = (v << 6) | (c & 63);
      }
      const min = len === 2 ? 0x80 : len === 3 ? 0x800 : 0x10000;
      if (ok && v >= min && v <= 0x10ffff && !(v >= 0xd800 && v <= 0xdfff)) {
        cp = v;
      } else {
        len = 1;
      }
    }
    out += String.fromCodePoint(cp);
    i += len;
  }
  return out;
}

/** `application/x-www-form-urlencoded`, as WorkOS's token endpoint takes. */
export function formEncode(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}
