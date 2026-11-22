/**
 * Files read from a computer, kept for the session (docs/mobile.md
 * "Files"): the decrypted bytes in memory by (host, space, path), and a
 * local copy an image view, a PDF view or the share sheet can open (a file
 * in the app's cache directory; a blob URL on web). Cleared on sign-out.
 */
import { Directory, File, Paths } from 'expo-file-system';

export interface CachedFile {
  bytes: Uint8Array;
  name: string;
  mime: string;
  /** A URI views load it from; `null` when none could be made. */
  uri: string | null;
}

const web = process.env.EXPO_OS === 'web';
const cache = new Map<string, CachedFile>();

export const fileKey = (host: string, space: string, path: string): string =>
  `${host}|${space}|${path}`;

export const getCachedFile = (key: string): CachedFile | null =>
  cache.get(key) ?? null;

/** A URI for `bytes`: a file under the cache directory, or a blob URL. */
export async function localCopy(
  key: string,
  bytes: Uint8Array,
  name: string,
  mime: string,
): Promise<string | null> {
  try {
    if (web) {
      return URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
    }
    const dir = new Directory(Paths.cache, 'theodore-files');
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const safe = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-120) || 'file';
    const file = new File(dir, `${hash(key)}-${safe}`);
    await file.write(bytes);
    return file.uri;
  } catch {
    return null;
  }
}

/** Keeps `bytes` and makes its local copy; returns what is cached. */
export async function cacheFile(
  key: string,
  bytes: Uint8Array,
  name: string,
  mime: string,
): Promise<CachedFile> {
  const uri = await localCopy(key, bytes, name, mime);
  const entry: CachedFile = { bytes, name, mime, uri };
  cache.set(key, entry);
  return entry;
}

/** Sign-out: nothing of the files stays. */
export function clearFileCache(): void {
  for (const f of cache.values()) {
    if (web && f.uri) URL.revokeObjectURL(f.uri);
    else if (f.uri) {
      try {
        new File(f.uri).delete();
      } catch {
        // already gone
      }
    }
  }
  cache.clear();
}

/** A short stable id for a key (FNV-1a), for the cached copy's name. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
