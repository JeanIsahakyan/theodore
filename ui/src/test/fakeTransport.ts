/** A scriptable `Transport` for tests — no Tauri, no network. */
import type { Transport, Unlisten } from '../core/transport';

export class FakeTransport implements Transport {
  /** Queued responses per command, consumed in order; falls back to `handlers`. */
  private readonly queues = new Map<string, unknown[]>();
  private readonly handlers = new Map<
    string,
    (args?: Record<string, unknown>) => unknown
  >();
  readonly calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  private readonly listeners = new Map<
    string,
    Set<(payload: unknown) => void>
  >();

  /** The next N calls to `cmd` resolve with `values`, in order. */
  queueResult(cmd: string, ...values: unknown[]): void {
    this.queues.set(cmd, [...(this.queues.get(cmd) ?? []), ...values]);
  }

  /** Fallback for a command when the queue is empty. */
  onCall(cmd: string, fn: (args?: Record<string, unknown>) => unknown): void {
    this.handlers.set(cmd, fn);
  }

  async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    this.calls.push({ cmd, args });
    const q = this.queues.get(cmd);
    if (q && q.length) {
      const next = q.shift();
      if (next instanceof Error) throw next;
      return next as T;
    }
    const h = this.handlers.get(cmd);
    if (h) return h(args) as T;
    throw new Error(`FakeTransport: no response queued for "${cmd}"`);
  }

  async listen<T>(event: string, cb: (payload: T) => void): Promise<Unlisten> {
    const set = this.listeners.get(event) ?? new Set();
    set.add(cb as (payload: unknown) => void);
    this.listeners.set(event, set);
    return () => set.delete(cb as (payload: unknown) => void);
  }

  /** Fire `event` to every listener, as the Tauri event bus would. */
  emit(event: string, payload: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) cb(payload);
  }
}
