import { sha256 } from '@noble/hashes/sha2.js';
import { utf8 } from './base64';

/**
 * A human-comparable fingerprint of a public key, as the desktop shows it
 * (`fleet_protocol::fingerprint`): the first 16 bytes of SHA-256 of the
 * base64 key string, hex, in 8 groups of 4 ("a1b2 c3d4 … 0718").
 */
export function fingerprint(publicKey: string): string {
  const hex = [...sha256(utf8(publicKey)).slice(0, 16)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex.match(/.{4}/g)!.join(' ');
}
