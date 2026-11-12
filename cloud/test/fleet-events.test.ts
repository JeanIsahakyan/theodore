import { describe, expect, it } from 'vitest';
import type { RemoteSpaceEvent } from '../src/gen/fleet';
import { CLOUD_RING } from '../src/fleet/limits';
import { Harness, startSpace, type Device } from './fleet-harness';

const status: RemoteSpaceEvent = { kind: 'status', status: 'running' };
const started: RemoteSpaceEvent = {
  kind: 'started',
  host_device: 'h',
  origin_device: 'o',
  project_id: 'p1',
  project_name: 'theodore',
  name: 'S',
  branch: 'b',
  mode: 'edit',
  parent: null,
  depth: 0,
};

async function setup() {
  const h = new Harness();
  const mac1 = await h.device('user_1', 'mac1');
  const mac2 = await h.device('user_1', 'mac2');
  await mac1.connect();
  await mac2.connect();
  await startSpace(mac1, mac2, 'rs_1');
  mac1.clear();
  mac2.clear();
  const emit = (seq: number, event = status) => {
    h.now += 25; // stay under the rate limit
    return mac2.send({ type: 'space_event', space: 'rs_1', seq, event });
  };
  return { h, mac1, mac2, emit };
}

const seqs = (d: Device) =>
  d
    .take('space_event')
    .map((e) =>
      e.event.kind === 'gap' ? `gap${e.event.from}-${e.event.to}` : e.seq,
    );

describe('fleet events', () => {
  it('takes events only from the space’s host', async () => {
    const { mac1 } = await setup();
    await mac1.send({
      type: 'space_event',
      space: 'rs_1',
      seq: 1,
      event: status,
    });
    expect(mac1.take('error')[0]?.code).toBe('fleet.not_yours');
    await mac1.send({
      type: 'space_event',
      space: 'rs_nope',
      seq: 1,
      event: status,
    });
    expect(mac1.take('error')[0]?.code).toBe('fleet.not_yours');
  });

  it('refuses a gap event from a device', async () => {
    const { mac2 } = await setup();
    await mac2.send({
      type: 'space_event',
      space: 'rs_1',
      seq: 1,
      event: { kind: 'gap', from: 1, to: 2 },
    });
    expect(mac2.take('error')[0]?.code).toBe('fleet.bad_message');
  });

  it('streams history then live, deduped, with a gap for a jump', async () => {
    const { mac1, emit } = await setup();
    await emit(1);
    await emit(2);
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    expect(seqs(mac1)).toEqual([1, 2]);
    await emit(2); // replayed twice: dropped
    await emit(3);
    await emit(6); // 4..5 lost
    expect(seqs(mac1)).toEqual([3, 'gap4-5', 6]);
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 3 });
    expect(seqs(mac1)).toEqual(['gap4-5', 6]);
    await mac1.send({ type: 'unsubscribe', space: 'rs_1' });
    await emit(7);
    expect(seqs(mac1)).toEqual([]);
  });

  it('marks what fell out of the ring, keeping the started event', async () => {
    const { mac1, emit } = await setup();
    await emit(1, started);
    for (let s = 2; s <= CLOUD_RING + 100; s++) await emit(s);
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    const got = mac1.take('space_event');
    expect(got).toHaveLength(CLOUD_RING + 2);
    expect(got[0]).toMatchObject({ seq: 1, event: started });
    expect(got[1]?.event).toEqual({ kind: 'gap', from: 2, to: 100 });
    expect(got[2]?.seq).toBe(101);
    expect(got.at(-1)?.seq).toBe(CLOUD_RING + 100);
  });

  it('gaps from `since` when it is older than the ring', async () => {
    const { mac1, emit } = await setup();
    for (let s = 1; s <= CLOUD_RING + 10; s++) await emit(s);
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 5 });
    const got = mac1.take('space_event');
    expect(got[0]?.event).toEqual({ kind: 'gap', from: 6, to: 10 });
    expect(got[1]?.seq).toBe(11);
  });

  it('forbids another user’s subscribe', async () => {
    const { h, emit } = await setup();
    await emit(1);
    const theirs = await h.device('user_2', 'theirs');
    await theirs.connect();
    await theirs.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    expect(theirs.take('error')[0]?.code).toBe('fleet.not_yours');
    await emit(2);
    expect(theirs.take('space_event')).toEqual([]);
  });

  it('drops subscriptions with the connection', async () => {
    const { mac1, emit } = await setup();
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    await mac1.disconnect();
    await mac1.connect();
    await emit(1);
    expect(mac1.take('space_event')).toEqual([]);
  });
});
