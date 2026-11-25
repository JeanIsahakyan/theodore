/**
 * Web: a non-extractable WebCrypto Ed25519 key, stored as a `CryptoKey` in
 * IndexedDB, when the browser signs with Ed25519 (Chrome 137+, Firefox
 * 129+, Safari 17+). Older browsers get a noble key whose 32-byte seed is
 * kept in IndexedDB: readable by script on this origin, so weaker; it's
 * made only where WebCrypto can't do it, and kept until "forget".
 *
 * One store per JS runtime (as on native): every fleet client of the page
 * shares the key's promise. A read that throws makes no key.
 */
import { log } from '../telemetry/log';
import { fromBase64, toBase64 } from './base64';
import { SEED_BYTES, seedKey } from './ed25519';
import { idb } from './idb';
import { DEVICE_KEY, KEY_GENERATED } from './seed-store';
import type { DeviceKey, KeyStore } from './types';
import {
  generateWebKey,
  webDeviceKey,
  webEd25519Supported,
  type WebKeyRecord,
} from './webcrypto';

type Stored =
  ({ kind: 'webcrypto' } & WebKeyRecord) | { kind: 'seed'; seed: string };

async function load(): Promise<DeviceKey> {
  const subtle = globalThis.crypto?.subtle;
  let stored = await idb.get<Stored>(DEVICE_KEY);
  // Nothing there: once more, in case another tab was writing.
  if (stored === undefined || stored === null) {
    stored = await idb.get<Stored>(DEVICE_KEY);
  }
  if (stored?.kind === 'webcrypto' && subtle) {
    return webDeviceKey(subtle, stored);
  }
  if (stored?.kind === 'seed') {
    const seed = fromBase64(stored.seed);
    if (seed?.length === SEED_BYTES) return seedKey(seed);
  }
  if (stored) throw new Error('the stored device key is unreadable');
  if (subtle && (await webEd25519Supported(subtle))) {
    const rec = await generateWebKey(subtle);
    await idb.set(DEVICE_KEY, { kind: 'webcrypto', ...rec });
    log.warn('fleet device key generated', {
      'error.code': KEY_GENERATED,
      reason: 'none_stored',
      kind: 'webcrypto',
    });
    return webDeviceKey(subtle, rec);
  }
  const seed = crypto.getRandomValues(new Uint8Array(SEED_BYTES));
  await idb.set(DEVICE_KEY, { kind: 'seed', seed: toBase64(seed) });
  log.warn('fleet device key generated', {
    'error.code': KEY_GENERATED,
    reason: 'none_stored',
    kind: 'seed',
  });
  return seedKey(seed);
}

const runtime = globalThis as { __theodoreKeyStore?: KeyStore };

export function createKeyStore(): KeyStore {
  if (runtime.__theodoreKeyStore) return runtime.__theodoreKeyStore;
  let key: Promise<DeviceKey> | null = null;
  const store: KeyStore = {
    deviceKey() {
      key ??= load().catch((e: unknown) => {
        key = null;
        throw e;
      });
      return key;
    },
    async forget() {
      key = null;
      await idb.remove(DEVICE_KEY);
      log.info('fleet device key forgotten');
    },
  };
  runtime.__theodoreKeyStore = store;
  return store;
}
