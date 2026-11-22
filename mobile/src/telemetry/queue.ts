/**
 * A bounded batch queue for a remote sink: items wait, go out in batches,
 * are retried with backoff on 5xx / 429 / network errors, and are dropped
 * on another 4xx, after `attempts` tries, when the queue overflows, or
 * once they have waited too long (offline for good).
 *
 * ```text
 * push ─▶ queue (≤ maxQueued, oldest dropped) ─▶ full batch, or every flushMs
 *      ─▶ send(batch) ─▶ ok           ─▶ next
 *                      ─▶ retry       ─▶ wait backoff × 2^n (±25 %), again ≤ attempts
 *                      ─▶ drop        ─▶ gone
 * clear ─▶ everything queued is dropped (a switch turned off)
 * ```
 */

export type SendOutcome = 'ok' | 'retry' | 'drop';

export interface QueueOptions<T> {
  send(batch: T[]): Promise<SendOutcome>;
  /** A batch goes out at this many. */
  batchSize: number;
  /** …or this long after the first item queued. */
  flushMs: number;
  attempts: number;
  backoffMs: number;
  backoffMaxMs: number;
  /** Over this many waiting, the oldest are dropped. */
  maxQueued: number;
  /** An item older than this is dropped instead of sent (offline too long). */
  maxAgeMs: number;
  /** A batch is cut so its JSON stays under this (0: no cap). */
  maxBatchBytes?: number;
  bytesOf?(item: T): number;
  now?: () => number;
  random?: () => number;
}

export interface BatchQueue<T> {
  push(item: T): void;
  /** Sends what waits now; resolves when the attempt is done. */
  flush(): Promise<void>;
  clear(): void;
  size(): number;
  /** Tests: the number of batches sent so far. */
  sent(): number;
}

export function createQueue<T>(o: QueueOptions<T>): BatchQueue<T> {
  const now = o.now ?? Date.now;
  const random = o.random ?? Math.random;
  let items: { at: number; item: T }[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<void> | null = null;
  let sentBatches = 0;
  let failures = 0;
  let retryAt = 0;

  const schedule = (ms: number) => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, ms);
  };

  const takeBatch = (): T[] => {
    const fresh = items.filter((x) => now() - x.at <= o.maxAgeMs);
    items = fresh;
    const out: T[] = [];
    let bytes = 0;
    while (items.length && out.length < o.batchSize) {
      const next = items[0]!.item;
      const size = o.bytesOf?.(next) ?? 0;
      if (o.maxBatchBytes && out.length && bytes + size > o.maxBatchBytes) break;
      out.push(next);
      bytes += size;
      items.shift();
    }
    return out;
  };

  const flush = async (): Promise<void> => {
    if (inflight) return inflight;
    if (!items.length) return;
    const wait = retryAt - now();
    if (wait > 0) {
      schedule(wait);
      return;
    }
    const batch = takeBatch();
    if (!batch.length) return;
    inflight = (async () => {
      let outcome: SendOutcome;
      try {
        outcome = await o.send(batch);
      } catch {
        outcome = 'retry';
      }
      if (outcome === 'ok') {
        sentBatches += 1;
        failures = 0;
        retryAt = 0;
      } else if (outcome === 'retry' && failures + 1 < o.attempts) {
        failures += 1;
        const exp = Math.min(o.backoffMaxMs, o.backoffMs * 2 ** (failures - 1));
        retryAt = now() + exp * (0.75 + random() * 0.5);
        // Back in front, in order.
        items = [...batch.map((item) => ({ at: now(), item })), ...items];
      } else {
        // Dropped: a 4xx, or out of tries.
        failures = 0;
        retryAt = 0;
      }
    })().finally(() => {
      inflight = null;
    });
    await inflight;
    if (items.length) schedule(Math.max(0, retryAt - now()) || o.flushMs);
  };

  return {
    push(item) {
      items.push({ at: now(), item });
      if (items.length > o.maxQueued) items.splice(0, items.length - o.maxQueued);
      if (items.length >= o.batchSize) void flush();
      else schedule(o.flushMs);
    },
    flush,
    clear() {
      items = [];
      if (timer) clearTimeout(timer);
      timer = null;
    },
    size: () => items.length,
    sent: () => sentBatches,
  };
}

/** The outcome of an HTTP response, the way both sinks read one. */
export function outcomeOf(status: number): SendOutcome {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 429 || status >= 500) return 'retry';
  return 'drop';
}
