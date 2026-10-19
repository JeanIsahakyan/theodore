import { beforeEach, describe, expect, it } from 'vitest';
import { setTransport } from './core/transport';
import { FakeTransport } from './test/fakeTransport';
import { modelAccessors } from './sync';
import { SyncClient } from './sync/SyncClient';
import { EphemeralStore } from './stores/EphemeralStore';
import type { RootStore } from './stores/RootStore';
import { assignTask, markDone, snoozePrs, unsnooze } from './actions';

/** Just the two members every action under test touches — `models` reads
 *  straight through `sync.pool`, so it is wired up the same way `RootStore`
 *  wires it, not re-implemented. */
function fakeStore(): RootStore {
  const sync = new SyncClient();
  const ephemeral = new EphemeralStore();
  const models = modelAccessors(sync.pool);
  return { sync, ephemeral, models } as unknown as RootStore;
}

let transport: FakeTransport;

beforeEach(() => {
  transport = new FakeTransport();
  setTransport(transport);
  transport.onCall('transact', () => ({ status: 'ok', last_sync_id: 1 }));
});

describe('markDone', () => {
  it('marks every id done, pushes one undo step, and toasts an Undo action', () => {
    const store = fakeStore();
    markDone(store, ['pr-1', 'pr-2']);

    expect(store.models.inboxStates.get('pr-1')).toMatchObject({
      done: true,
      snooze: null,
    });
    expect(store.models.inboxStates.get('pr-2')).toMatchObject({
      done: true,
    });
    expect(store.sync.undo.canUndo).toBe(true);

    const toast = store.ephemeral.toasts.at(-1);
    expect(toast?.text).toBe('Marked 2 done');
    expect(toast?.action?.label).toBe('Undo');
  });

  it('undo reverses it through the undo queue, not a local rollback', async () => {
    const store = fakeStore();
    markDone(store, ['pr-1']);
    expect(store.models.inboxStates.get('pr-1')?.done).toBe(true);

    const toast = store.ephemeral.toasts.at(-1)!;
    toast.action!.onAction();
    await Promise.resolve();
    await Promise.resolve();

    // It did not exist before `markDone` created it — undo deletes it again.
    expect(store.models.inboxStates.get('pr-1')).toBeUndefined();
  });
});

describe('snoozePrs', () => {
  it('snoozes and offers Undo', () => {
    const store = fakeStore();
    snoozePrs(store, ['pr-1'], { kind: 'next_push' });

    expect(store.models.inboxStates.get('pr-1')).toMatchObject({
      done: false,
      snooze: { kind: 'next_push' },
    });
    expect(store.sync.undo.canUndo).toBe(true);
    expect(store.ephemeral.toasts.at(-1)?.text).toBe('Snoozed');
  });
});

describe('unsnooze', () => {
  it('clears the snooze and offers Undo', () => {
    const store = fakeStore();
    snoozePrs(store, ['pr-1'], { kind: 'next_push' });
    unsnooze(store, 'pr-1');

    expect(store.models.inboxStates.get('pr-1')?.snooze).toBeNull();
    expect(store.ephemeral.toasts.at(-1)?.text).toBe('Unsnoozed');
  });
});

describe('assignTask', () => {
  it('assigns and offers Undo', () => {
    const store = fakeStore();
    store.sync.pool.put('task', 't1', {
      id: 't1',
      assignee: { kind: 'human', id: 'nobody' },
      status: 'todo',
    });

    assignTask(store, 't1', { kind: 'agent', id: 'claude' });

    expect(store.models.tasks.get('t1')).toMatchObject({
      assignee: { kind: 'agent', id: 'claude' },
      status: 'progress',
    });
    expect(store.sync.undo.canUndo).toBe(true);
    expect(store.ephemeral.toasts.at(-1)?.text).toBe('Assigned to claude');
  });
});
