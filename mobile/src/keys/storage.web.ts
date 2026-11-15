/** Pins and ids on web: IndexedDB (same origin only). */
import { idb } from './idb';
import type { SecretStorage } from './storage-types';

export function createSecureStorage(): SecretStorage {
  return {
    get: async (k) => {
      const v = await idb.get<unknown>(k);
      return typeof v === 'string' ? v : null;
    },
    set: (k, v) => idb.set(k, v),
    remove: (k) => idb.remove(k),
  };
}
