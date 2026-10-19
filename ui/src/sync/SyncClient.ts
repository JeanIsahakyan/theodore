/**
 * Bootstraps the pool and keeps it current: `Global` scope on startup, one
 * `Pr` scope lazily per opened PR, `sync` events applied strictly in order,
 * gaps closed with `catch_up`.
 */
import { makeObservable, observable, runInAction } from 'mobx';
import { api } from '../core/api';
import { getTransport, type Unlisten } from '../core/transport';
import type { PrId, SyncFrame, WireAction, WireRow } from '../gen/contract';
import { ObjectPool } from './ObjectPool';
import { TransactionQueue } from './TransactionQueue';
import { UndoQueue } from './UndoQueue';
import type { ModelName } from './types';

export type SyncStatus = 'idle' | 'bootstrapping' | 'online' | 'error';

export class SyncClient {
  readonly pool = new ObjectPool();
  readonly queue: TransactionQueue;
  readonly undo: UndoQueue;

  status: SyncStatus = 'idle';
  lastSyncId = 0;
  error: string | undefined;

  private readonly loadedPrs = new Set<PrId>();
  private readonly loadingPrs = new Map<PrId, Promise<void>>();
  private unlisten: Unlisten | undefined;
  /** Serializes frame handling so catch-up and live frames never interleave. */
  private chain: Promise<void> = Promise.resolve();

  constructor() {
    this.queue = new TransactionQueue(this.pool);
    this.undo = new UndoQueue(this.queue);
    makeObservable(this, {
      status: observable,
      lastSyncId: observable,
      error: observable,
    });
  }

  async start(): Promise<void> {
    this.setStatus('bootstrapping');
    try {
      const boot = await api.bootstrap({ scope: 'global' });
      runInAction(() => {
        this.applyRows(boot.rows);
        this.lastSyncId = boot.last_sync_id;
      });
      this.unlisten = await getTransport().listen<SyncFrame>(
        'sync',
        (frame) => {
          this.chain = this.chain.then(() => this.onFrame(frame));
        },
      );
      this.setStatus('online');
    } catch (e) {
      this.setError(e);
    }
  }

  /** Lazily loads one PR's models; a no-op once loaded. */
  async openPr(pr: PrId): Promise<void> {
    if (this.loadedPrs.has(pr)) return;
    const inFlight = this.loadingPrs.get(pr);
    if (inFlight) return inFlight;
    const p = (async () => {
      const boot = await api.bootstrap({ scope: 'pr', pr });
      runInAction(() => {
        this.applyRows(boot.rows);
        if (boot.last_sync_id > this.lastSyncId)
          this.lastSyncId = boot.last_sync_id;
      });
      this.loadedPrs.add(pr);
    })();
    this.loadingPrs.set(pr, p);
    try {
      await p;
    } finally {
      this.loadingPrs.delete(pr);
    }
  }

  isPrLoaded(pr: PrId): boolean {
    return this.loadedPrs.has(pr);
  }

  private applyRows(rows: WireRow[]): void {
    for (const r of rows) {
      this.pool.put(r.model as ModelName, r.id, r.data, r.archived);
    }
  }

  private async onFrame(frame: SyncFrame): Promise<void> {
    try {
      if (frame.from_sync_id > this.lastSyncId) {
        // A frame arrived past where we stand: something was missed, fetch it.
        await this.catchUp();
      }
      if (frame.last_sync_id <= this.lastSyncId) return; // stale/duplicate
      runInAction(() => {
        this.applyActions(frame.actions);
        this.lastSyncId = frame.last_sync_id;
      });
    } catch (e) {
      this.setError(e);
    }
  }

  private async catchUp(): Promise<void> {
    const delta = await api.catchUp(this.lastSyncId);
    if (delta.resync_required) {
      // The sync log was compacted past where we stood: `delta.actions` is
      // empty and can't close the gap incrementally. Bootstrap from
      // scratch instead of applying it.
      await this.resync();
      return;
    }
    runInAction(() => {
      this.applyActions(delta.actions);
      this.lastSyncId = Math.max(this.lastSyncId, delta.last_sync_id);
    });
  }

  /** Discards the pool and re-bootstraps every scope we had loaded — the
   *  same shape as `start()`, but without tearing down the frame listener
   *  (the connection itself is still fine; only our local copy is stale). */
  private async resync(): Promise<void> {
    const openPrs = [...this.loadedPrs];
    this.pool.clear();
    this.loadedPrs.clear();
    const boot = await api.bootstrap({ scope: 'global' });
    runInAction(() => {
      this.applyRows(boot.rows);
      this.lastSyncId = boot.last_sync_id;
    });
    for (const pr of openPrs) await this.openPr(pr);
  }

  private applyActions(actions: WireAction[]): void {
    for (const a of actions) this.applyAction(a);
  }

  private applyAction(a: WireAction): void {
    const model = a.model as ModelName;
    switch (a.action) {
      case 'I':
        this.pool.put(model, a.model_id, a.data, false);
        return;
      case 'U':
        this.pool.put(
          model,
          a.model_id,
          a.data,
          this.pool.isArchived(model, a.model_id),
        );
        return;
      case 'C':
        this.pool.merge(
          model,
          a.model_id,
          (a.data as Record<string, unknown>) ?? {},
        );
        return;
      case 'A':
        this.pool.put(
          model,
          a.model_id,
          a.data ?? this.pool.get(model, a.model_id),
          true,
        );
        return;
      case 'D':
        this.pool.remove(model, a.model_id);
        return;
    }
  }

  private setStatus(s: SyncStatus): void {
    runInAction(() => {
      this.status = s;
      this.error = undefined;
    });
  }

  private setError(e: unknown): void {
    runInAction(() => {
      this.status = 'error';
      this.error = e instanceof Error ? e.message : String(e);
    });
  }

  /** Manual reconnect after `status` went to `error` (e.g. an offline
   *  banner's "Retry") — tears down the old frame listener and bootstraps
   *  again. A no-op while already connecting or connected. */
  async retry(): Promise<void> {
    if (this.status === 'online' || this.status === 'bootstrapping') return;
    this.unlisten?.();
    this.unlisten = undefined;
    await this.start();
  }

  dispose(): void {
    this.unlisten?.();
  }
}
