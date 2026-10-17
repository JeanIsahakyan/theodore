/**
 * Write path: `transact()` applies optimistically to the pool, sends the
 * transaction to core, and rolls back on `Rejected` or a transport error.
 * The canonical state still arrives later through the `sync` event — this
 * queue only owns the local optimistic guess and its undo.
 */
import { makeObservable, observableShallow, runInAction } from 'mobx';
import { api } from '../core/api';
import type {
  MutationOp,
  Transaction,
  TransactionResult,
} from '../gen/contract';
import { ObjectPool } from './ObjectPool';
import type { ModelName } from './types';

/** What a single op changed, captured before applying — enough to undo it. */
export interface OpSnapshot {
  op: MutationOp;
  /** The row as it was before this op (`undefined` if it did not exist). */
  before: unknown;
  /** Whether the row was archived before this op. */
  wasArchived: boolean;
}

export interface PendingTransaction {
  id: string;
  ops: MutationOp[];
}

let uid = 0;
export const nextTransactionId = (): string =>
  `tx_${Date.now().toString(36)}_${++uid}`;

export class TransactionQueue {
  /** Transactions sent, not yet resolved; observed by the UI (e.g. a sync spinner). */
  pending: PendingTransaction[] = [];

  private readonly listeners = new Set<
    (ops: MutationOp[], inverse: MutationOp[]) => void
  >();

  constructor(private readonly pool: ObjectPool) {
    makeObservable(this, { pending: observableShallow });
  }

  /** Called once per committed transaction, with its ops and their inverse. */
  onApplied(
    fn: (ops: MutationOp[], inverse: MutationOp[]) => void,
  ): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Apply `ops` optimistically and send them as one transaction. */
  async transact(ops: MutationOp[]): Promise<TransactionResult> {
    const id = nextTransactionId();
    const snapshots = ops.map((op) => this.snapshot(op));
    runInAction(() => {
      ops.forEach((op, i) => applyOp(this.pool, op, snapshots[i]!));
      this.pending = [...this.pending, { id, ops }];
    });
    const inverse = buildInverse(ops, snapshots);
    for (const fn of this.listeners) fn(ops, inverse);

    const tx: Transaction = { id, ops };
    try {
      const result = await api.transact(tx);
      if (result.status === 'rejected') this.rollback(snapshots);
      return result;
    } catch (e) {
      this.rollback(snapshots);
      return { status: 'rejected', reason: (e as Error).message };
    } finally {
      runInAction(() => {
        this.pending = this.pending.filter((t) => t.id !== id);
      });
    }
  }

  private snapshot(op: MutationOp): OpSnapshot {
    const model = op.model as ModelName;
    return {
      op,
      before: this.pool.get(model, op.id),
      wasArchived: this.pool.isArchived(model, op.id),
    };
  }

  private rollback(snapshots: OpSnapshot[]): void {
    runInAction(() => {
      for (const s of [...snapshots].reverse()) {
        const model = s.op.model as ModelName;
        if (s.before === undefined) this.pool.remove(model, s.op.id);
        else this.pool.put(model, s.op.id, s.before, s.wasArchived);
      }
    });
  }
}

function applyOp(pool: ObjectPool, op: MutationOp, snap: OpSnapshot): void {
  const model = op.model as ModelName;
  switch (op.op) {
    case 'create':
      pool.put(model, op.id, op.data);
      return;
    case 'update':
      pool.merge(model, op.id, op.data as Record<string, unknown>);
      return;
    case 'archive':
      if (snap.before !== undefined) pool.put(model, op.id, snap.before, true);
      return;
    case 'delete':
      pool.remove(model, op.id);
      return;
  }
}

/** The ops that undo `ops`, from what they overwrote. Archive has no inverse
 *  in the wire contract (no `unarchive` op) — see final report. */
function buildInverse(
  ops: MutationOp[],
  snapshots: OpSnapshot[],
): MutationOp[] {
  const out: MutationOp[] = [];
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i]!;
    const before = snapshots[i]!.before as Record<string, unknown> | undefined;
    if (op.op === 'create') {
      out.push({ op: 'delete', model: op.model, id: op.id });
    } else if (op.op === 'update' && before) {
      const data: Record<string, unknown> = {};
      for (const key of Object.keys(op.data as Record<string, unknown>)) {
        data[key] = before[key];
      }
      out.push({ op: 'update', model: op.model, id: op.id, data });
    } else if (op.op === 'delete' && before) {
      out.push({ op: 'create', model: op.model, id: op.id, data: before });
    }
    // 'archive' is intentionally not inverted: the contract has no unarchive op.
  }
  return out;
}
