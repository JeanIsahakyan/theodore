/**
 * Identity map of synced rows: one observable map per model, live and
 * archived kept apart like `WireRow.archived`. Components read through this
 * (via `observer`), never through a whole-state hook.
 */
import { observable, runInAction, type ObservableMap } from 'mobx';
import { MODEL_NAMES, type ModelName, type ModelRows } from './types';

export class ObjectPool {
  private readonly live = new Map<ModelName, ObservableMap<string, unknown>>();
  private readonly archived = new Map<
    ModelName,
    ObservableMap<string, unknown>
  >();

  constructor() {
    for (const name of MODEL_NAMES) {
      this.live.set(name, observable.map({}, { deep: false }));
      this.archived.set(name, observable.map({}, { deep: false }));
    }
  }

  get<K extends ModelName>(model: K, id: string): ModelRows[K] | undefined {
    return (this.live.get(model)!.get(id) ??
      this.archived.get(model)!.get(id)) as ModelRows[K] | undefined;
  }

  isArchived(model: ModelName, id: string): boolean {
    return this.archived.get(model)!.has(id);
  }

  all<K extends ModelName>(model: K): ModelRows[K][] {
    return [...this.live.get(model)!.values()] as ModelRows[K][];
  }

  allArchived<K extends ModelName>(model: K): ModelRows[K][] {
    return [...this.archived.get(model)!.values()] as ModelRows[K][];
  }

  where<K extends ModelName>(
    model: K,
    pred: (row: ModelRows[K]) => boolean,
  ): ModelRows[K][] {
    return this.all(model).filter(pred);
  }

  /**
   * Insert or fully replace a row. `id` is always stamped onto the stored
   * object — some rows (`pr_summary`, `setting`) carry no `id` field of
   * their own; the pool key is the only place it lives.
   */
  put(model: ModelName, id: string, data: unknown, archived = false): void {
    const row = { ...(data as object), id };
    runInAction(() => {
      if (archived) {
        this.live.get(model)!.delete(id);
        this.archived.get(model)!.set(id, row);
      } else {
        this.archived.get(model)!.delete(id);
        this.live.get(model)!.set(id, row);
      }
    });
  }

  /** Merge fields into an existing row (creates it if absent). */
  merge(model: ModelName, id: string, data: Record<string, unknown>): void {
    const existing = this.get(model, id) as Record<string, unknown> | undefined;
    this.put(model, id, { ...existing, ...data }, this.isArchived(model, id));
  }

  remove(model: ModelName, id: string): unknown {
    const row = this.get(model, id);
    runInAction(() => {
      this.live.get(model)!.delete(id);
      this.archived.get(model)!.delete(id);
    });
    return row;
  }

  clear(): void {
    runInAction(() => {
      for (const m of this.live.values()) m.clear();
      for (const m of this.archived.values()) m.clear();
    });
  }

  count(model: ModelName): number {
    return this.live.get(model)!.size;
  }
}
