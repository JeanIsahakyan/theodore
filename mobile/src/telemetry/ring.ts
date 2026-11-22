/**
 * The local log: a bounded ring of redacted records, always on, kept in
 * the app's data storage (files on native, IndexedDB on web, memory in
 * tests: `src/fleet/data.ts`), never leaving the device unless the user
 * exports it (Settings → About → Copy diagnostics).
 *
 * ```text
 * record ─▶ ring (newest last) ─▶ RING_MAX records, RING_BYTES chars of JSON
 *        ─▶ written 2 s later (sooner when the app leaves the foreground)
 * start  ─▶ read back, shape-checked
 * ```
 */
import type { DataStorage } from '../fleet/data';
import type { Fields, FieldValue, Kind, Level, TelemetryRecord } from './types';

export const RING_KEY = 'theodore.telemetry.log';
export const RING_MAX = 2000;
export const RING_BYTES = 1024 * 1024;
export const RING_SAVE_DELAY_MS = 2000;

const LEVELS: readonly Level[] = ['debug', 'info', 'warn', 'error'];
const KINDS: readonly Kind[] = ['log', 'product', 'error'];

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

function cleanFields(v: unknown): Fields {
  if (!isObj(v)) return {};
  const out: Fields = {};
  for (const [k, x] of Object.entries(v)) {
    if (
      x === null ||
      typeof x === 'string' ||
      typeof x === 'number' ||
      typeof x === 'boolean'
    )
      out[k] = x as FieldValue;
  }
  return out;
}

/** A record read back; `null` when it isn't one. */
export function cleanRecord(v: unknown): TelemetryRecord | null {
  if (!isObj(v)) return null;
  if (typeof v.ts !== 'number' || typeof v.msg !== 'string') return null;
  if (!LEVELS.includes(v.level as Level) || !KINDS.includes(v.kind as Kind))
    return null;
  const r: TelemetryRecord = {
    ts: v.ts,
    level: v.level as Level,
    kind: v.kind as Kind,
    msg: v.msg.slice(0, 4096),
    fields: cleanFields(v.fields),
  };
  if (typeof v.op_id === 'string') r.op_id = v.op_id.slice(0, 64);
  if (typeof v.event === 'string') r.event = v.event.slice(0, 64);
  return r;
}

/** `records` trimmed from the front to the ring's bounds. */
export function trimRing(
  records: TelemetryRecord[],
  max = RING_MAX,
  bytes = RING_BYTES,
): TelemetryRecord[] {
  let out =
    records.length > max ? records.slice(records.length - max) : records;
  let size = out.reduce((n, r) => n + JSON.stringify(r).length + 1, 0);
  let drop = 0;
  while (size > bytes && drop < out.length - 1) {
    size -= JSON.stringify(out[drop]!).length + 1;
    drop += 1;
  }
  if (drop) out = out.slice(drop);
  return out;
}

export interface Ring {
  push(r: TelemetryRecord): void;
  /** Oldest first. */
  records(): TelemetryRecord[];
  /** Reads what was kept across restarts (before it, the ring is what
   *  this run logged). */
  load(): Promise<void>;
  /** Writes now; resolves once stored. */
  flush(): Promise<void>;
  clear(): Promise<void>;
}

export function createRing(
  storage: DataStorage,
  opts: { max?: number; bytes?: number; saveDelayMs?: number } = {},
): Ring {
  const max = opts.max ?? RING_MAX;
  const bytes = opts.bytes ?? RING_BYTES;
  const delay = opts.saveDelayMs ?? RING_SAVE_DELAY_MS;
  let records: TelemetryRecord[] = [];
  let loaded = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();

  const write = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = null;
    const text = JSON.stringify(records);
    writing = writing.then(() => storage.set(RING_KEY, text)).catch(() => {});
    return writing;
  };
  const schedule = () => {
    timer ??= setTimeout(() => void write(), delay);
  };

  return {
    push(r) {
      records.push(r);
      // Trim in bulk, not per record: the bounds hold within a few percent.
      if (records.length > max + 100) records = trimRing(records, max, bytes);
      schedule();
    },
    records: () => trimRing(records, max, bytes),
    async load() {
      if (loaded) return;
      loaded = true;
      const text = await storage.get(RING_KEY).catch(() => null);
      if (!text) return;
      let v: unknown;
      try {
        v = JSON.parse(text);
      } catch {
        return;
      }
      if (!Array.isArray(v)) return;
      const kept = v
        .map(cleanRecord)
        .filter((r): r is TelemetryRecord => r !== null);
      // What this run logged before the read stays newest.
      records = trimRing([...kept, ...records], max, bytes);
    },
    flush() {
      records = trimRing(records, max, bytes);
      return write();
    },
    async clear() {
      records = [];
      if (timer) clearTimeout(timer);
      timer = null;
      await storage.remove(RING_KEY).catch(() => {});
    },
  };
}
