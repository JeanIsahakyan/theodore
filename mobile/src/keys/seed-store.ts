/**
 * A `KeyStore` whose private key is a 32-byte seed kept in a
 * `SecretStorage` (native: the Keychain/Keystore; web without WebCrypto
 * Ed25519: IndexedDB; Node: memory), signing with noble.
 */
import { fromBase64, toBase64 } from './base64';
import { SEED_BYTES, seedKey } from './ed25519';
import type { SecretStorage } from './storage-types';
import type { DeviceKey, KeyStore } from './types';

export const DEVICE_KEY = 'theodore.fleet.device_key';

export function seedKeyStore(
  storage: SecretStorage,
  randomBytes: (n: number) => Uint8Array,
): KeyStore {
  let key: Promise<DeviceKey> | null = null;
  const load = async (): Promise<DeviceKey> => {
    const stored = await storage.get(DEVICE_KEY);
    const seed = stored ? fromBase64(stored.trim()) : null;
    if (seed && seed.length === SEED_BYTES) return seedKey(seed);
    if (stored) {
      // Unreadable: never silently replace a key others may have pinned.
      throw new Error('the stored device key is unreadable');
    }
    const fresh = randomBytes(SEED_BYTES);
    await storage.set(DEVICE_KEY, toBase64(fresh));
    return seedKey(fresh);
  };
  return {
    deviceKey() {
      key ??= load().catch((e: unknown) => {
        key = null;
        throw e;
      });
      return key;
    },
    async forget() {
      key = null;
      await storage.remove(DEVICE_KEY);
    },
  };
}
