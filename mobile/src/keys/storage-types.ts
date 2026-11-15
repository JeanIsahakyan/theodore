/**
 * Small secrets and pins kept on this device: the iOS Keychain / Android
 * Keystore (expo-secure-store) on native, IndexedDB on web, memory in Node
 * (tests). Keys use `[A-Za-z0-9._-]` only (secure-store's rule).
 */
export interface SecretStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** A storage key made safe for secure-store (other characters → `_`). */
export function storageKey(...parts: string[]): string {
  return parts.join('.').replace(/[^A-Za-z0-9._-]/g, '_');
}

/** In memory only: Node, tests, previews. */
export function memoryStorage(): SecretStorage {
  const m = new Map<string, string>();
  return {
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => {
      m.set(k, v);
    },
    remove: async (k) => {
      m.delete(k);
    },
  };
}
