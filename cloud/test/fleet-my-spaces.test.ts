// Protocol 12: the cloud lists a device the spaces it may follow
// (`my_spaces`), so a phone whose saved list is gone gets it back
// (docs/fleet.md "The list comes from the cloud").
import { describe, expect, it } from 'vitest';
import type { Delegation, MySpace } from '../src/gen/fleet';
import { MAX_MY_SPACES, PROTOCOL_VERSION } from '../src/fleet/limits';
import { BadMessage, parseClient } from '../src/fleet/wire';
import { Harness, startSpace, type Device } from './fleet-harness';

const lists = (d: Device) => d.take('my_spaces').map((m) => m.list);
const ids = (list: MySpace[]) => list.map((s) => s.space);

async function delegateTo(origin: Device, delegate: Device, revoke = false) {
  const body: Delegation = {
    origin_device: origin.id!,
    delegate_device: delegate.id!,
    issued_at_ms: origin.h.now,
    expires_at_ms: 0,
    revoke,
  };
  await origin.send({
    type: 'delegate',
    envelope: await origin.seal('delegate', body),
  });
}

/** The phone started rs_1 (named, running) and rs_2 on the mac. */
async function setup() {
  const h = new Harness();
  const mac = await h.device('user_1', 'mac');
  const phone = await h.phone();
  await mac.connect();
  await phone.connect();
  await startSpace(phone, mac, 'rs_1');
  await mac.emit('rs_1', 1, {
    kind: 'started',
    host_device: mac.id!,
    origin_device: phone.id!,
    project_id: 'p1',
    project_name: 'theodore',
    name: 'Fix login',
    branch: 'b',
    mode: 'edit',
    parent: null,
    depth: 0,
  });
  await mac.emit('rs_1', 2, { kind: 'status', status: 'running' });
  h.now += 1000;
  await startSpace(phone, mac, 'rs_2');
  return { h, mac, phone };
}

describe('my_spaces', () => {
  it('follows every welcome on 12, with what the cloud holds, newest first', async () => {
    const { mac, phone } = await setup();
    await phone.disconnect();
    await phone.connect();
    const [list] = lists(phone);
    expect(list).toEqual([
      {
        space: 'rs_2',
        host_device: mac.id,
        origin_device: phone.id,
        name: null,
        mode: null,
        status: null,
        last_seq: 0,
        last_ms: expect.any(Number),
      },
      {
        space: 'rs_1',
        host_device: mac.id,
        origin_device: phone.id,
        name: 'Fix login',
        mode: 'edit',
        status: 'running',
        last_seq: 2,
        last_ms: expect.any(Number),
      },
    ]);
    // The host is never told its hosted spaces as "my spaces".
    await mac.disconnect();
    await mac.connect();
    expect(lists(mac)).toEqual([[]]);
  });

  it('is never sent below 12, and list_my_spaces is unknown there', async () => {
    const { h, phone } = await setup();
    await phone.disconnect();
    const old = await h.phone('user_1', 'old phone');
    old.protocol = 11;
    await old.connect();
    expect(lists(old)).toEqual([]);
    await old.send({ type: 'list_my_spaces' });
    expect(old.take('error').map((e) => e.code)).toEqual(['fleet.bad_message']);
    expect(lists(old)).toEqual([]);
  });

  it('answers list_my_spaces on demand', async () => {
    const { phone } = await setup();
    phone.clear();
    await phone.send({ type: 'list_my_spaces' });
    expect(lists(phone).map(ids)).toEqual([['rs_2', 'rs_1']]);
  });

  it('lists only the same user’s spaces, and a delegator’s only while it delegates', async () => {
    const { h, mac, phone } = await setup();
    // Another user's phone and device, in the same org.
    const intruder = await h.phone('user_2', 'intruder');
    const theirMac = await h.device('user_2', 'their mac');
    await intruder.connect();
    await theirMac.connect();
    await startSpace(intruder, theirMac, 'rs_theirs');
    expect(lists(intruder)).toEqual([[]]);
    intruder.clear();
    await intruder.send({ type: 'list_my_spaces' });
    expect(lists(intruder).map(ids)).toEqual([['rs_theirs']]);
    phone.clear();
    await phone.send({ type: 'list_my_spaces' });
    expect(lists(phone).map(ids)).toEqual([['rs_2', 'rs_1']]);

    // The mac starts one on another computer of the same user.
    const mac2 = await h.device('user_1', 'mac2');
    await mac2.connect();
    await startSpace(mac, mac2, 'rs_mac');
    const tablet = await h.phone('user_1', 'iPad');
    await tablet.connect();
    expect(lists(tablet)).toEqual([[]]);
    await delegateTo(mac, tablet);
    tablet.clear();
    await tablet.send({ type: 'list_my_spaces' });
    const [list] = lists(tablet);
    expect(ids(list!)).toEqual(['rs_mac']);
    expect(list![0]!.origin_device).toBe(mac.id);
    // Listed means it may follow it: the subscription is taken.
    await tablet.send({ type: 'subscribe', space: 'rs_mac', since: 0 });
    expect(tablet.take('error')).toEqual([]);
    // Revoked: gone from its list.
    await delegateTo(mac, tablet, true);
    tablet.clear();
    await tablet.send({ type: 'list_my_spaces' });
    expect(lists(tablet)).toEqual([[]]);
  });

  it('lists the spaces an adopt moved, asked again after it', async () => {
    const { h, mac, phone } = await setup();
    const old = phone.id!;
    await phone.disconnect();
    await mac.send({ type: 'remove_device', device_id: old });
    const again = await h.phone();
    await again.connect();
    expect(lists(again)).toEqual([[]]);
    await again.send({ type: 'adopt', previous: [old] });
    await again.send({ type: 'list_my_spaces' });
    expect(lists(again).map(ids)).toEqual([['rs_2', 'rs_1']]);
  });

  it('is bounded', async () => {
    const { h, mac, phone } = await setup();
    // Rows as the cloud keeps them (starting 200 spaces through requests
    // would hit the per-user pending cap first).
    for (let i = 0; i < MAX_MY_SPACES + 5; i++) {
      h.db
        .prepare(
          `INSERT INTO spaces (space, user_id, host_device, origin_device,
             parent, depth, last_seq, status, last_ms)
           VALUES (?, 'user_1', ?, ?, NULL, 0, 0, NULL, ?)`,
        )
        .all(`rs_bulk_${i}`, mac.id!, phone.id!, h.now + i);
    }
    phone.clear();
    await phone.send({ type: 'list_my_spaces' });
    const [list] = lists(phone);
    expect(list).toHaveLength(MAX_MY_SPACES);
    expect(list![0]!.space).toBe(`rs_bulk_${MAX_MY_SPACES + 4}`);
  });

  it('is read strictly', () => {
    expect(
      parseClient(JSON.stringify({ type: 'list_my_spaces' }), PROTOCOL_VERSION),
    ).toEqual({ type: 'list_my_spaces' });
    expect(() =>
      parseClient(JSON.stringify({ type: 'list_my_spaces' }), 11),
    ).toThrow(BadMessage);
  });
});
