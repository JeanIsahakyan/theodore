/**
 * Cache for immutable data keyed by content (a revision at a sha, a file at
 * a sha+path) — a loaded value is never invalidated, only evicted (LRU), so
 * it needs no query library. In-flight loads for the same key are deduped.
 * A failed load is not data: once it is `retryAfterMs` old the next `get()`
 * loads again (the wait keeps an observer that re-renders on the error from
 * retrying in a loop), and `invalidate()` retries at once.
 */
import { makeObservable, observable, observableRef, runInAction } from 'mobx';

export type ResourceStatus = 'loading' | 'ready' | 'error';

export class Resource<T> {
  status: ResourceStatus = 'loading';
  data: T | undefined;
  error: string | undefined;

  constructor() {
    makeObservable(this, {
      status: observable,
      data: observableRef,
      error: observable,
    });
  }
}

export interface ResourceCacheOptions {
  /** Max distinct keys kept; the least recently touched is evicted first. */
  limit?: number;
  /** How long a failed load is served as is before a `get()` retries it. */
  retryAfterMs?: number;
}

export class ResourceCache<T> {
  private readonly entries = new Map<string, Resource<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();
  private readonly order: string[] = [];
  /** When each errored key failed — an entry here is due for a retry. */
  private readonly failedAt = new Map<string, number>();
  private readonly limit: number;
  private readonly retryAfterMs: number;

  constructor(opts: ResourceCacheOptions = {}) {
    this.limit = opts.limit ?? 200;
    this.retryAfterMs = opts.retryAfterMs ?? 5000;
  }

  /** Returns the cached/loading resource, kicking off `load()` at most once
   *  per key — or again for a key whose last load failed long enough ago. */
  get(key: string, load: () => Promise<T>): Resource<T> {
    this.touch(key);
    const existing = this.entries.get(key);
    const failed = this.failedAt.get(key);
    if (existing && !(failed !== undefined && this.stale(failed)))
      return existing;
    this.failedAt.delete(key);

    const res = new Resource<T>();
    this.entries.set(key, res);
    this.evictIfNeeded();

    const promise =
      this.inFlight.get(key) ?? load().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);

    promise.then(
      (data) =>
        runInAction(() => {
          res.status = 'ready';
          res.data = data;
        }),
      (e: unknown) => {
        // Only the entry still cached for the key may be marked for retry.
        if (this.entries.get(key) === res) this.failedAt.set(key, Date.now());
        runInAction(() => {
          res.status = 'error';
          res.error = e instanceof Error ? e.message : String(e);
        });
      },
    );
    return res;
  }

  private stale(failedAt: number): boolean {
    return Date.now() - failedAt >= this.retryAfterMs;
  }

  /** Current value without triggering a load, for callers that already know it's warm. */
  peek(key: string): T | undefined {
    return this.entries.get(key)?.data;
  }

  /** Drops the key so the next `get()` loads it again — the "Retry" path. */
  invalidate(key: string): void {
    this.entries.delete(key);
    this.failedAt.delete(key);
    const i = this.order.indexOf(key);
    if (i >= 0) this.order.splice(i, 1);
  }

  clear(): void {
    this.entries.clear();
    this.failedAt.clear();
    this.inFlight.clear();
    this.order.length = 0;
  }

  private touch(key: string): void {
    const i = this.order.indexOf(key);
    if (i >= 0) this.order.splice(i, 1);
    this.order.push(key);
  }

  private evictIfNeeded(): void {
    while (this.order.length > this.limit) {
      const oldest = this.order.shift();
      if (oldest !== undefined && !this.inFlight.has(oldest)) {
        this.entries.delete(oldest);
        this.failedAt.delete(oldest);
      }
    }
  }
}

/** One cache per distinct kind of resource — call once, reuse the instance. */
export function resourceCache<T>(
  opts?: ResourceCacheOptions,
): ResourceCache<T> {
  return new ResourceCache<T>(opts);
}
