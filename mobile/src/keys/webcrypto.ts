/**
 * Ed25519 through WebCrypto (web): the private key is made non-extractable,
 * so script can sign with it but never read it.
 */
import { toBase64 } from './base64';
import type { DeviceKey } from './types';

const ED25519 = { name: 'Ed25519' } as const;

/** Whether this runtime's WebCrypto signs with Ed25519. */
export async function webEd25519Supported(
  subtle: SubtleCrypto | undefined,
): Promise<boolean> {
  if (!subtle) return false;
  try {
    const pair = (await subtle.generateKey(ED25519, false, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    await subtle.sign(ED25519, pair.privateKey, new Uint8Array(1));
    return true;
  } catch {
    return false;
  }
}

export interface WebKeyRecord {
  privateKey: CryptoKey;
  /** Base64 of the raw 32-byte public key. */
  publicKey: string;
}

export async function generateWebKey(
  subtle: SubtleCrypto,
): Promise<WebKeyRecord> {
  const pair = (await subtle.generateKey(ED25519, false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: toBase64(raw) };
}

export function webDeviceKey(
  subtle: SubtleCrypto,
  rec: WebKeyRecord,
): DeviceKey {
  return {
    publicKey: rec.publicKey,
    sign: async (message) =>
      toBase64(
        new Uint8Array(
          await subtle.sign(ED25519, rec.privateKey, Uint8Array.from(message)),
        ),
      ),
  };
}
