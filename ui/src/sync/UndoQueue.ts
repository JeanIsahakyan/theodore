/**
 * Undo/redo as new transactions, never as a local-only rollback — an undone
 * edit is a normal write and shows up in the sync log like any other.
 */
import { makeObservable, observableShallow, runInAction } from 'mobx';
import type { MutationOp } from '../gen/contract';
import type { TransactionQueue } from './TransactionQueue';

interface Step {
  /** Ops that undo the step, grouped as they were originally committed. */
  inverse: MutationOp[][];
}

const LIMIT = 100;

export class UndoQueue {
  undoStack: Step[] = [];
  redoStack: Step[] = [];

  constructor(private readonly queue: TransactionQueue) {
    makeObservable(this, {
      undoStack: observableShallow,
      redoStack: observableShallow,
    });
  }

  /** Run `fn`; every transaction it commits becomes one undo step. */
  run<T>(fn: () => T): T {
    const inverse: MutationOp[][] = [];
    const off = this.queue.onApplied((_ops, inv) => {
      if (inv.length) inverse.push(inv);
    });
    try {
      return fn();
    } finally {
      off();
      if (inverse.length) {
        runInAction(() => {
          this.undoStack = [...this.undoStack, { inverse }].slice(-LIMIT);
          this.redoStack = [];
        });
      }
    }
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Sends the inverse ops as new transactions; returns once they are queued. */
  async undo(): Promise<boolean> {
    const step = this.undoStack.at(-1);
    if (!step) return false;
    runInAction(() => (this.undoStack = this.undoStack.slice(0, -1)));
    const redoInverse: MutationOp[][] = [];
    const off = this.queue.onApplied((_ops, inv) => {
      if (inv.length) redoInverse.push(inv);
    });
    try {
      // Undo in the reverse order the original transactions were committed.
      for (const ops of [...step.inverse].reverse()) {
        await this.queue.transact(ops);
      }
    } finally {
      off();
    }
    runInAction(() => {
      this.redoStack = [...this.redoStack, { inverse: redoInverse }];
    });
    return true;
  }

  async redo(): Promise<boolean> {
    const step = this.redoStack.at(-1);
    if (!step) return false;
    runInAction(() => (this.redoStack = this.redoStack.slice(0, -1)));
    const undoInverse: MutationOp[][] = [];
    const off = this.queue.onApplied((_ops, inv) => {
      if (inv.length) undoInverse.push(inv);
    });
    try {
      for (const ops of [...step.inverse].reverse()) {
        await this.queue.transact(ops);
      }
    } finally {
      off();
    }
    runInAction(() => {
      this.undoStack = [...this.undoStack, { inverse: undoInverse }];
    });
    return true;
  }

  clear(): void {
    runInAction(() => {
      this.undoStack = [];
      this.redoStack = [];
    });
  }
}
