// Protocol 11: a device that joined again under a new id (removed from the
// fleet while it was away, or with a new key) takes over the spaces the same
// user started from its earlier ids (docs/fleet.md "A device id changes").
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../src/fleet/limits';
import { BadMessage, parseClient } from '../src/fleet/wire';
import { Harness, startSpace, type Device } from './fleet-harness';

const errors = (d: Device) => d.take('error').map((e) => e.code);

const origins = (h: Harness) =>
  Object.fromEntries(
    (
      h.db
        .prepare('SELECT space, origin_device FROM spaces ORDER BY space')
        .all() as { space: string; origin_device: string }[]
    ).map((r) => [r.space, r.origin_device]),
  );

/** The phone started rs_1 and rs_2 on the mac, then was removed while away. */
async function setup() {
  const h = new Harness();
  const mac = await h.device('user_1', 'mac');
  const phone = await h.phone();
  await mac.connect();
  await phone.connect();
  await startSpace(phone, mac, 'rs_1');
  await startSpace(phone, mac, 'rs_2');
  await mac.emit('rs_1', 1, { kind: 'status', status: 'running' });
  const old = phone.id!;
  await phone.disconnect();
  await mac.send({ type: 'remove_device', device_id: old });
  mac.clear();
  // The same phone, a new key (the cloud forgot its row anyway): a new id.
  const again = await h.phone();
  await again.connect();
  expect(again.id).not.toBe(old);
  mac.clear();
  return { h, mac, phone: again, old };
}

describe('adopt', () => {
  it('moves the same user’s spaces to the new id and tells the hosts', async () => {
    const { h, mac, phone, old } = await setup();
    // Not its space yet: the cloud won't let it follow.
    await phone.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    expect(errors(phone)).toEqual(['fleet.not_yours']);

    await phone.send({ type: 'adopt', previous: [old, phone.id!] });
    expect(origins(h)).toEqual({ rs_1: phone.id, rs_2: phone.id });
    expect(mac.take('device_adopted')).toEqual([
      { type: 'device_adopted', device: phone.id, previous: old },
    ]);
    await phone.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    expect(errors(phone)).toEqual([]);
    expect(phone.stream()).toEqual([1]);
    await mac.emit('rs_1', 2, { kind: 'status', status: 'idle' });
    expect(phone.stream()).toEqual([2]);

    // Again: nothing left to take, nothing said.
    await phone.send({ type: 'adopt', previous: [old] });
    expect(mac.take('device_adopted')).toEqual([]);
    expect(errors(phone)).toEqual([]);
  });

  it('never gives one user another user’s spaces', async () => {
    const { h, mac, phone, old } = await setup();
    const other = await h.phone('user_2', 'intruder');
    await other.connect();
    await other.send({ type: 'adopt', previous: [old] });
    expect(origins(h)).toEqual({ rs_1: old, rs_2: old });
    expect(mac.take('device_adopted')).toEqual([]);
    await other.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    expect(errors(other)).toEqual(['fleet.not_yours']);
    // The rightful phone still can.
    await phone.send({ type: 'adopt', previous: [old] });
    expect(origins(h)).toEqual({ rs_1: phone.id, rs_2: phone.id });
  });

  it('leaves a live device’s spaces, and an id nothing is known about, alone', async () => {
    const h = new Harness();
    const mac = await h.device('user_1', 'mac');
    const phone = await h.phone();
    const tablet = await h.phone('user_1', 'iPad');
    for (const d of [mac, phone, tablet]) await d.connect();
    await startSpace(phone, mac, 'rs_1');
    mac.clear();
    // Online under that id: not an earlier id of anyone's.
    await tablet.send({ type: 'adopt', previous: [phone.id!] });
    expect(origins(h)).toEqual({ rs_1: phone.id });
    await tablet.send({
      type: 'adopt',
      previous: ['dev_00000000-0000-4000-8000-00000000dead'],
    });
    expect(mac.take('device_adopted')).toEqual([]);
    expect(errors(tablet)).toEqual([]);
    // Offline, but still the user's device with its own key: its spaces may
    // be taken over (a phone whose key changed, its old row still there).
    await phone.disconnect();
    await tablet.send({ type: 'adopt', previous: [phone.id!] });
    expect(origins(h)).toEqual({ rs_1: tablet.id });
    expect(mac.take('device_adopted')).toEqual([
      { type: 'device_adopted', device: tablet.id, previous: phone.id },
    ]);
  });

  it('tells only hosts on protocol 11', async () => {
    const h = new Harness();
    const mac = await h.device('user_1', 'mac');
    mac.protocol = 10;
    const phone = await h.phone();
    await mac.connect();
    await phone.connect();
    await startSpace(phone, mac, 'rs_1');
    const old = phone.id!;
    await phone.disconnect();
    const again = await h.phone();
    await again.connect();
    mac.clear();
    await again.send({ type: 'adopt', previous: [old] });
    expect(origins(h)).toEqual({ rs_1: again.id });
    expect(mac.take('device_adopted')).toEqual([]);
    // Another phone (no host) hears nothing either.
    expect(again.take('device_adopted')).toEqual([]);
  });

  it('is read strictly', () => {
    const adopt = (previous: unknown) =>
      parseClient(
        JSON.stringify({ type: 'adopt', previous }),
        PROTOCOL_VERSION,
      );
    expect(adopt(['dev_00000000-0000-4000-8000-000000000001'])).toEqual({
      type: 'adopt',
      previous: ['dev_00000000-0000-4000-8000-000000000001'],
    });
    expect(() => adopt(['phone'])).toThrow(BadMessage);
    expect(() => adopt('dev_00000000-0000-4000-8000-000000000001')).toThrow(
      BadMessage,
    );
    expect(() =>
      adopt(
        Array.from(
          { length: 11 },
          (_, i) => `dev_00000000-0000-4000-8000-0000000000${i}0`,
        ),
      ),
    ).toThrow(BadMessage);
  });
});
