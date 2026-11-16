/**
 * Default `createKeyStore` (Node / tests): a noble key whose seed lives in
 * memory. The app gets `store.native.ts` (Keychain/Keystore) or
 * `store.web.ts` (WebCrypto + IndexedDB) from Metro.
 */
import { seedKeyStore } from './seed-store';
import { memoryStorage } from './storage-types';
import type { KeyStore } from './types';

export function createKeyStore(): KeyStore {
  return seedKeyStore(memoryStorage(), (n) =>
    crypto.getRandomValues(new Uint8Array(n)),
  );
}
