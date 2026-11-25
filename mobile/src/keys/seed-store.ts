/**
 * A `KeyStore` whose private key is a 32-byte seed kept in a
 * `SecretStorage` (native: the Keychain/Keystore; web without WebCrypto
 * Ed25519: IndexedDB; Node: memory), signing with noble.
 *
 * The key is this device's identity in the fleet: the cloud issues its
 * device id for it, other devices pin it. It is made once, on first use,
 * and never replaced on its own:
 *
 * ```text
 * read ─▶ a seed        ─▶ the key
 *      ─▶ unreadable    ─▶ error (a key others pinned is never replaced silently)
 *      ─▶ throws        ─▶ error (the keychain is locked, a read failed): no new key,
 *                          the caller fails or retries
 *      ─▶ nothing, twice ─▶ a new key, written; read back, so two stores over one
 *                          storage racing at first launch agree on one key
 *                          (logged: fleet.key_generated)
 * ```
 */
import { log } from '../telemetry/log';
import { fromBase64, toBase64 } from './base64';
import { SEED_BYTES, seedKey } from './ed25519';
import type { SecretStorage } from './storage-types';
import type { DeviceKey, KeyStore } from './types';

export const DEVICE_KEY = 'theodore.fleet.device_key';

/** A device key generated: a new fleet identity (docs/telemetry.md "Mobile"). */
export const KEY_GENERATED = 'fleet.key_generated';

const seedOf = (stored: string | null): Uint8Array | null => {
  const seed = stored ? fromBase64(stored.trim()) : null;
  return seed && seed.length === SEED_BYTES ? seed : null;
};

export function seedKeyStore(
  storage: SecretStorage,
  randomBytes: (n: number) => Uint8Array,
): KeyStore {
  let key: Promise<DeviceKey> | null = null;
  const load = async (): Promise<DeviceKey> => {
    // A read that throws (a locked keychain, a failing store) is the
    // caller's to retry: it never makes a key.
    let stored = await storage.get(DEVICE_KEY);
    // Nothing there: once more before a new key is made, in case the first
    // read came back empty while another writer was at it.
    if (stored === null) stored = await storage.get(DEVICE_KEY);
    const seed = seedOf(stored);
    if (seed) return seedKey(seed);
    if (stored) {
      // Unreadable: never silently replace a key others may have pinned.
      throw new Error('the stored device key is unreadable');
    }
    const fresh = randomBytes(SEED_BYTES);
    await storage.set(DEVICE_KEY, toBase64(fresh));
    // Another store over the same storage may have written first: whatever
    // is stored now is the key of this device, for both.
    const kept =
      seedOf(await storage.get(DEVICE_KEY).catch(() => null)) ?? fresh;
    log.warn('fleet device key generated', {
      'error.code': KEY_GENERATED,
      reason: 'none_stored',
      raced: kept !== fresh,
    });
    return seedKey(kept);
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
      log.info('fleet device key forgotten');
    },
  };
}
