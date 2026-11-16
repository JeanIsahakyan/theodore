/**
 * iOS / Android: one file per key in the app's documents directory
 * (expo-file-system). A copy restored from a backup onto another phone is
 * never used: it names a fleet device id the new phone doesn't have
 * (`src/fleet/saved.ts`).
 */
import { Directory, File, Paths } from 'expo-file-system';
import type { DataStorage } from './data';

const DIR = 'theodore-fleet';

export function createDataStorage(): DataStorage {
  let dir: Directory | null = null;
  const folder = (): Directory => {
    if (!dir) {
      const d = new Directory(Paths.document, DIR);
      d.create({ idempotent: true, intermediates: true });
      dir = d;
    }
    return dir;
  };
  const file = (k: string) => new File(folder(), `${k}.json`);
  return {
    async get(k) {
      const f = file(k);
      return f.exists ? f.text() : null;
    },
    async set(k, v) {
      // Written aside, then moved over: a kill mid-write leaves the old value.
      const tmp = new File(folder(), `${k}.json.tmp`);
      await tmp.write(v);
      await tmp.move(file(k), { overwrite: true });
    },
    async remove(k) {
      const f = file(k);
      if (f.exists) f.delete();
    },
  };
}
