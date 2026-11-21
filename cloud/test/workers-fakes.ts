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
