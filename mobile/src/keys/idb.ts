/**
 * A tiny IndexedDB key-value store (web): one database, one object store.
 * Values are structured clones, so a non-extractable `CryptoKey` is stored
 * as is (the browser keeps its private half out of reach of script).
 */
const DB = 'theodore';
const STORE = 'fleet';

let opened: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      opened = null;
      reject(req.error ?? new Error('IndexedDB unavailable'));
    };
  });
  return opened;
}

async function run<T>(
  mode: IDBTransactionMode,
  op: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const d = await db();
  return new Promise<T>((resolve, reject) => {
    const req = op(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB failed'));
  });
}

export const idb = {
  get: <T>(key: string) =>
    run<T | undefined>('readonly', (s) => s.get(key)).then((v) => v ?? null),
  set: (key: string, value: unknown) =>
    run<IDBValidKey>('readwrite', (s) => s.put(value, key)).then(() => {}),
  remove: (key: string) =>
    run<undefined>('readwrite', (s) => s.delete(key)).then(() => {}),
};
