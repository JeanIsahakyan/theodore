// Workers bindings outside workerd: KV in memory, a Durable Object state
// over node:sqlite.
import type { DatabaseSync } from 'node:sqlite';

/** Workers KV, in memory (expiry ignored). */
export class FakeKv {
  m = new Map<string, string>();
  async get(key: string, o?: unknown) {
    const v = this.m.get(key);
    if (v === undefined) return null;
    const type = typeof o === 'string' ? o : (o as { type?: string })?.type;
    return type === 'json' ? JSON.parse(v) : v;
  }
  async put(key: string, value: string) {
    this.m.set(key, value);
  }
  async delete(key: string) {
    this.m.delete(key);
  }
  async list(o: { prefix?: string } = {}) {
    const keys = [...this.m.keys()]
      .filter((k) => k.startsWith(o.prefix ?? ''))
      .sort()
      .map((name) => ({ name }));
    return { keys, list_complete: true, cacheStatus: null };
  }
}

interface Stored {
  bytes: Uint8Array;
  customMetadata: Record<string, string>;
  uploaded: Date;
}

/**
 * An R2 bucket in memory: the part of `R2Bucket` the blob routes use
 * (`src/fleet/blobs.ts`, `BlobBucket`). A stream handed to `put` is read
 * here, as R2 would; `streamed` counts those, so a test can tell a chunk was
 * never buffered by the Worker.
 */
export class FakeR2 {
  objects = new Map<string, Stored>();
  streamed = 0;

  private object(key: string, o: Stored) {
    return {
      key,
      size: o.bytes.byteLength,
      customMetadata: o.customMetadata,
      uploaded: o.uploaded,
      httpMetadata: {},
    };
  }

  async head(key: string) {
    const o = this.objects.get(key);
    return o ? this.object(key, o) : null;
  }

  async get(key: string) {
    const o = this.objects.get(key);
    if (!o) return null;
    return {
      ...this.object(key, o),
      body: new Response(o.bytes.slice()).body!,
      arrayBuffer: async () => o.bytes.slice().buffer,
    };
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options: { customMetadata?: Record<string, string> } = {},
  ) {
    let bytes: Uint8Array;
    if (value instanceof ReadableStream) {
      this.streamed += 1;
      bytes = new Uint8Array(await new Response(value).arrayBuffer());
    } else if (typeof value === 'string') {
      bytes = new TextEncoder().encode(value);
    } else if (value === null) {
      bytes = new Uint8Array();
    } else if (ArrayBuffer.isView(value)) {
      bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    } else {
      bytes = new Uint8Array(value);
    }
    const stored: Stored = {
      bytes,
      customMetadata: options.customMetadata ?? {},
      uploaded: new Date(),
    };
    this.objects.set(key, stored);
    return this.object(key, stored);
  }

  async delete(keys: string | string[]) {
    for (const k of [keys].flat()) this.objects.delete(k);
  }

  async list(o: { prefix?: string } = {}) {
    const objects = [...this.objects.entries()]
      .filter(([k]) => k.startsWith(o.prefix ?? ''))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => this.object(k, v));
    return { objects, truncated: false as const, delimitedPrefixes: [] };
  }

  /** The keys stored, sorted. */
  keys(prefix = ''): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

/** A DO state for OrgHub outside workerd. */
export function doState(db: DatabaseSync): DurableObjectState {
  return {
    storage: {
      sql: {
        exec: (q: string, ...b: unknown[]) => ({
          toArray: () => db.prepare(q).all(...b),
        }),
      },
      getAlarm: async () => null,
      setAlarm: async () => {},
    },
    getWebSockets: () => [],
    acceptWebSocket: () => {},
    waitUntil: () => {},
  } as unknown as DurableObjectState;
}
