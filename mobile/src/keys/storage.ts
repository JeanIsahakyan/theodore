/**
 * Default `SecretStorage` (Node / tests): memory. Metro picks
 * `storage.native.ts` (secure-store) or `storage.web.ts` (IndexedDB) for
 * the app.
 */
import { memoryStorage, type SecretStorage } from './storage-types';

export function createSecureStorage(): SecretStorage {
  return memoryStorage();
}
