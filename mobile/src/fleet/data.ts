/**
 * Default `DataStorage` (Node / tests): memory. Metro picks `data.native.ts`
 * (files) or `data.web.ts` (IndexedDB) for the app.
 */
import { memoryStorage, type SecretStorage } from '../keys/storage-types';

/**
 * Larger values that aren't secrets (the spaces this device keeps,
 * `src/fleet/saved.ts`): secure-store caps a value near 2 KB on Android.
 * Same keys as `SecretStorage` (`[A-Za-z0-9._-]`).
 */
export type DataStorage = SecretStorage;

export function createDataStorage(): DataStorage {
  return memoryStorage();
}
