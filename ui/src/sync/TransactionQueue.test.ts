import { beforeEach, describe, expect, it } from 'vitest';
import { setTransport } from '../core/transport';
import { FakeTransport } from '../test/fakeTransport';
import { ObjectPool } from './ObjectPool';
import { TransactionQueue } from './TransactionQueue';

let transport: FakeTransport;
let pool: ObjectPool;
let queue: TransactionQueue;

beforeEach(() => {
  transport = new FakeTransport();
  setTransport(transport);
  pool = new ObjectPool();
  queue = new TransactionQueue(pool);
});

describe('TransactionQueue', () => {
  it('applies a create optimistically, before the transport call resolves', async () => {
    let resolveTx!: (v: unknown) => void;
    transport.onCall('transact', () => new Promise((r) => (resolveTx = r)));

    const promise = queue.transact([
      { op: 'create', model: 'task', id: 't1', data: { title: 'Fix' } },
    ]);
    // Optimistic apply happens synchronously, before the transport resolves.
    expect(pool.get('task', 't1')).toMatchObject({ title: 'Fix' });

    resolveTx({ status: 'ok', last_sync_id: 1 });
    await promise;
    expect(pool.get('task', 't1')).toMatchObject({ title: 'Fix' });
  });

  it('rolls back on Rejected', async () => {
    pool.put('task', 't1', { title: 'Original' });
    transport.queueResult('transact', { status: 'rejected', reason: 'nope' });

    const result = await queue.transact([
      { op: 'update', model: 'task', id: 't1', data: { title: 'Changed' } },
    ]);

    expect(result).toEqual({ status: 'rejected', reason: 'nope' });
    expect(pool.get('task', 't1')).toMatchObject({ title: 'Original' });
  });

  it('rolls back on a transport error and reports it as rejected', async () => {
    pool.put('task', 't1', { title: 'Original' });
    transport.queueResult('transact', new Error('core crashed'));

    const result = await queue.transact([
      { op: 'update', model: 'task', id: 't1', data: { title: 'Changed' } },
    ]);

    expect(result.status).toBe('rejected');
    expect(pool.get('task', 't1')).toMatchObject({ title: 'Original' });
  });

  it('update rollback restores only the fields that changed', async () => {
    pool.put('task', 't1', { title: 'Original', status: 'todo' });
    transport.queueResult('transact', { status: 'rejected', reason: 'no' });

    await queue.transact([
      { op: 'update', model: 'task', id: 't1', data: { title: 'Changed' } },
    ]);

    expect(pool.get('task', 't1')).toMatchObject({
      title: 'Original',
      status: 'todo',
    });
  });

  it('delete rollback restores the removed row', async () => {
    pool.put('task', 't1', { title: 'Keep me' });
    transport.queueResult('transact', { status: 'rejected', reason: 'no' });

    await queue.transact([{ op: 'delete', model: 'task', id: 't1' }]);

    expect(pool.get('task', 't1')).toMatchObject({ title: 'Keep me' });
  });

  it('archive rollback un-archives the row', async () => {
    pool.put('task', 't1', { title: 'Archive me' });
    transport.queueResult('transact', { status: 'rejected', reason: 'no' });

    await queue.transact([{ op: 'archive', model: 'task', id: 't1' }]);

    expect(pool.isArchived('task', 't1')).toBe(false);
    expect(pool.get('task', 't1')).toMatchObject({ title: 'Archive me' });
  });

  it('tracks pending transactions until they resolve', async () => {
    let resolveTx!: (v: unknown) => void;
    transport.onCall('transact', () => new Promise((r) => (resolveTx = r)));

    const promise = queue.transact([
      { op: 'create', model: 'task', id: 't1', data: {} },
    ]);
    expect(queue.pending).toHaveLength(1);

    resolveTx({ status: 'ok', last_sync_id: 1 });
    await promise;
    expect(queue.pending).toHaveLength(0);
  });
});
