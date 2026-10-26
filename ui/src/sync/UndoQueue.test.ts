import { beforeEach, describe, expect, it } from 'vitest';
import { setTransport } from '../core/transport';
import { FakeTransport } from '../test/fakeTransport';
import { ObjectPool } from './ObjectPool';
import { TransactionQueue } from './TransactionQueue';
import { UndoQueue } from './UndoQueue';

let pool: ObjectPool;
let queue: TransactionQueue;
let undo: UndoQueue;

beforeEach(() => {
  const transport = new FakeTransport();
  setTransport(transport);
  transport.onCall('transact', () => ({ status: 'ok', last_sync_id: 1 }));
  pool = new ObjectPool();
  queue = new TransactionQueue(pool);
  undo = new UndoQueue(queue);
});

describe('UndoQueue', () => {
  it('undoes a create as a new delete transaction', async () => {
    await undo.run(() =>
      queue.transact([
        { op: 'create', model: 'task', id: 't1', data: { title: 'New' } },
      ]),
    );
    expect(pool.get('task', 't1')).toBeDefined();
    expect(undo.canUndo).toBe(true);

    await undo.undo();
    expect(pool.get('task', 't1')).toBeUndefined();
    expect(undo.canUndo).toBe(false);
    expect(undo.canRedo).toBe(true);
  });

  it('redoes a create after undoing it', async () => {
    await undo.run(() =>
      queue.transact([
        { op: 'create', model: 'task', id: 't1', data: { title: 'New' } },
      ]),
    );
    await undo.undo();
    await undo.redo();
    expect(pool.get('task', 't1')).toMatchObject({ title: 'New' });
  });

  it('undoes an update by restoring the previous field values', async () => {
    pool.put('task', 't1', { title: 'Original' });
    await undo.run(() =>
      queue.transact([
        { op: 'update', model: 'task', id: 't1', data: { title: 'Changed' } },
      ]),
    );
    expect(pool.get('task', 't1')).toMatchObject({ title: 'Changed' });

    await undo.undo();
    expect(pool.get('task', 't1')).toMatchObject({ title: 'Original' });
  });

  it('groups every transaction committed inside run() into one undo step', async () => {
    await undo.run(() => {
      void queue.transact([
        { op: 'create', model: 'task', id: 't1', data: {} },
      ]);
      void queue.transact([
        { op: 'create', model: 'task', id: 't2', data: {} },
      ]);
    });
    await undo.undo();
    expect(pool.get('task', 't1')).toBeUndefined();
    expect(pool.get('task', 't2')).toBeUndefined();
    expect(undo.canUndo).toBe(false);
  });

  it('a fresh run() after an undo clears the redo stack', async () => {
    await undo.run(() =>
      queue.transact([{ op: 'create', model: 'task', id: 't1', data: {} }]),
    );
    await undo.undo();
    expect(undo.canRedo).toBe(true);

    await undo.run(() =>
      queue.transact([{ op: 'create', model: 'task', id: 't2', data: {} }]),
    );
    expect(undo.canRedo).toBe(false);
  });
});
