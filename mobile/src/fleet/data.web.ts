/** Browser: IndexedDB (same origin only), next to the pins. */
import { idb } from '../keys/idb';
import type { DataStorage } from './data';

export function createDataStorage(): DataStorage {
  return {
    get: async (k) => {
      const v = await idb.get<unknown>(k);
      return typeof v === 'string' ? v : null;
    },
    set: (k, v) => idb.set(k, v),
    remove: (k) => idb.remove(k),
  };
}
