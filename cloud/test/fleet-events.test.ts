import { describe, expect, it } from 'vitest';
import type { RemoteSpaceEvent, SpaceEventBody } from '../src/gen/fleet';
import { CLOUD_RING } from '../src/fleet/limits';
import { Harness, startSpace } from './fleet-harness';

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

// mac1 started rs_1 on mac2 (the host).
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
    return mac2.emit('rs_1', seq, event);
  };
  return { h, mac1, mac2, emit };
}

describe('fleet events', () => {
  it('takes events only from the space’s host', async () => {
    const { mac1 } = await setup();
    await mac1.emit('rs_1', 1, status);
    expect(mac1.take('error')[0]?.code).toBe('fleet.not_yours');
    await mac1.emit('rs_nope', 1, status);
    expect(mac1.take('error')[0]?.code).toBe('fleet.not_yours');
  });

  it('refuses an envelope that names another host than the sender', async () => {
    const { mac1, mac2 } = await setup();
    // The host's own body, under an envelope claiming another signer.
    const body: SpaceEventBody = {
      space: 'rs_1',
      seq: 1,
      host_device: mac2.id!,
      event: status,
    };
    await mac2.send({
      type: 'space_event',
      envelope: await mac2.seal('event', body, mac1.id!),
    });
    expect(mac2.take('error')[0]?.code).toBe('fleet.not_yours');
    // A body naming another host, enveloped as the sender.
    await mac2.send({
      type: 'space_event',
      envelope: await mac2.seal('event', { ...body, host_device: mac1.id! }),
    });
    expect(mac2.take('error')[0]?.code).toBe('fleet.not_yours');
  });

  it('refuses an event not signed as an event by the host’s key', async () => {
    const { h, mac1, mac2 } = await setup();
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    const body = {
      space: 'rs_1',
      seq: 1,
      host_device: mac2.id!,
      event: status,
    };
    // Signed as a request (wrong domain).
    const asRequest = await mac2.seal('request', body);
    // Signed by another key under the host's name.
    const stranger = await h.device('user_1', 'x');
    const foreign = await stranger.seal('event', body, mac2.id!);
    // The body changed after signing.
    const good = await mac2.seal('event', body);
    const tampered = { ...good, body: good.body.replace('running', 'failed') };
    for (const envelope of [asRequest, foreign, tampered]) {
      await mac2.send({ type: 'space_event', envelope });
    }
    expect(mac2.take('error').map((e) => e.code)).toEqual([
      'fleet.bad_signature',
      'fleet.bad_signature',
      'fleet.bad_signature',
    ]);
    expect(mac1.stream()).toEqual([]);
    // Nothing stored: seq 1 is still open.
    await mac2.send({ type: 'space_event', envelope: good });
    expect(mac1.stream()).toEqual([1]);
  });

  it('refuses a gap event from a device', async () => {
    const { mac2 } = await setup();
    await mac2.emit('rs_1', 1, {
      kind: 'gap',
      from: 1,
      to: 2,
    } as unknown as RemoteSpaceEvent);
    expect(mac2.take('error')[0]?.code).toBe('fleet.bad_message');
  });

  it('forwards the host’s envelope unchanged', async () => {
    const { mac1, emit } = await setup();
    const first = await emit(1);
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    const live = await emit(2);
    expect(mac1.take('space_event')).toEqual([
      { type: 'space_event', envelope: first },
      { type: 'space_event', envelope: live },
    ]);
  });

  it('streams history then live, deduped, with a gap for a jump', async () => {
    const { mac1, emit } = await setup();
    await emit(1);
    await emit(2);
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    expect(mac1.stream()).toEqual([1, 2]);
    await emit(2); // replayed twice: dropped
    await emit(3);
    await emit(6); // 4..5 lost
    expect(mac1.stream()).toEqual([3, 'gap4-5', 6]);
    expect(mac1.sent).toEqual([]);
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 3 });
    expect(mac1.stream()).toEqual(['gap4-5', 6]);
    await mac1.send({ type: 'unsubscribe', space: 'rs_1' });
    await emit(7);
    expect(mac1.stream()).toEqual([]);
  });

  it('sends the gap as its own unsigned message', async () => {
    const { mac1, emit } = await setup();
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    await emit(3);
    expect(mac1.take('space_gap')).toEqual([
      { type: 'space_gap', space: 'rs_1', from: 1, to: 2 },
    ]);
  });

  it('marks what fell out of the ring, keeping the started event', async () => {
    const { mac1, emit } = await setup();
    const first = await emit(1, started);
    for (let s = 2; s <= CLOUD_RING + 100; s++) await emit(s);
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    expect(mac1.sent[0]).toEqual({ type: 'space_event', envelope: first });
    const got = mac1.stream();
    expect(got).toHaveLength(CLOUD_RING + 2);
    expect(got.slice(0, 3)).toEqual([1, 'gap2-100', 101]);
    expect(got.at(-1)).toBe(CLOUD_RING + 100);
  });

  it('gaps from `since` when it is older than the ring', async () => {
    const { mac1, emit } = await setup();
    for (let s = 1; s <= CLOUD_RING + 10; s++) await emit(s);
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 5 });
    expect(mac1.stream().slice(0, 2)).toEqual(['gap6-10', 11]);
  });

  it('forbids another user’s subscribe', async () => {
    const { h, emit } = await setup();
    await emit(1);
    const theirs = await h.device('user_2', 'theirs');
    await theirs.connect();
    await theirs.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    expect(theirs.take('error')[0]?.code).toBe('fleet.not_yours');
    await emit(2);
    expect(theirs.stream()).toEqual([]);
  });

  it('lets only the space’s origin and host subscribe', async () => {
    const { h, mac1, mac2, emit } = await setup();
    await emit(1);
    // Same user, a third device: it may be untrusted, so it reads nothing.
    const mac3 = await h.device('user_1', 'mac3');
    await mac3.connect();
    mac3.clear();
    await mac3.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    expect(mac3.take('error')[0]?.code).toBe('fleet.not_yours');
    await emit(2);
    expect(mac3.stream()).toEqual([]);
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    await mac2.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    expect(mac1.stream()).toEqual([1, 2]);
    expect(mac2.stream()).toEqual([1, 2]);
  });

  it('drops subscriptions with the connection', async () => {
    const { mac1, emit } = await setup();
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    await mac1.disconnect();
    await mac1.connect();
    await emit(1);
    expect(mac1.stream()).toEqual([]);
  });
});
