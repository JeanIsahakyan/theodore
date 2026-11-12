import { describe, expect, it } from 'vitest';
import { MAX_DEVICES_PER_USER } from '../src/fleet/limits';
import { unb64 } from '../src/fleet/wire';
import { Harness, info } from './fleet-harness';

describe('fleet connect', () => {
  it('challenges, then welcomes a new device and lists it', async () => {
    const h = new Harness();
    const mac = await h.device();
    const { nonce } = await mac.open();
    expect(unb64(nonce)?.length).toBe(32);
    await mac.send({
      type: 'hello',
      protocol: 1,
      public_key: mac.publicKey,
      signature: await mac.signB64(unb64(nonce)!),
      info: info('mac1'),
      spaces: [],
    });
    const [welcome, devices] = mac.sent;
    expect(welcome).toEqual({
      type: 'welcome',
      device_id: expect.stringMatching(/^dev_[0-9a-f-]{36}$/),
      generation: 1,
      resume: {},
    });
    expect(devices).toEqual({
      type: 'devices',
      devices: [
        expect.objectContaining({
          device_id: (welcome as { device_id: string }).device_id,
          online: true,
          public_key: mac.publicKey,
          info: info('mac1'),
        }),
      ],
    });
  });

  it('bumps the generation and replaces the older connection', async () => {
    const h = new Harness();
    const mac = await h.device();
    await mac.connect();
    const first = mac.conn;
    const again = await mac.connect();
    expect(again.generation).toBe(2);
    expect(again.device_id).toBe(mac.id);
    expect(first.open).toBe(false);
    expect(first.closedWith?.code).toBe(4000);
    // The replaced socket's close doesn't take the device offline.
    mac.clear();
    await h.hub.closed(first);
    expect(mac.take('devices')).toEqual([]);
  });

  it('keeps the device id for a known key that lost its id', async () => {
    const h = new Harness();
    const mac = await h.device();
    const id = (await mac.connect()).device_id;
    await mac.disconnect();
    expect((await mac.connect({ deviceId: null })).device_id).toBe(id);
  });

  it('refuses a bad signature', async () => {
    const h = new Harness();
    const mac = await h.device();
    await mac.open();
    await mac.send({
      type: 'hello',
      protocol: 1,
      public_key: mac.publicKey,
      signature: await mac.signB64(new Uint8Array(32)),
      info: info(),
      spaces: [],
    });
    expect(mac.sent).toEqual([
      expect.objectContaining({ type: 'error', code: 'fleet.bad_signature' }),
    ]);
    expect(mac.conn.closedWith?.code).toBe(1008);
  });

  it('refuses a known device id with another key', async () => {
    const h = new Harness();
    const mac = await h.device();
    const { device_id } = await mac.connect();
    const thief = await h.device();
    await expect(thief.connect({ deviceId: device_id })).rejects.toThrow(
      /fleet.key_mismatch/,
    );
    expect(thief.conn.closedWith).toEqual({
      code: 4003,
      reason: 'fleet.key_mismatch',
    });
  });

  it('refuses another user’s device id, even with its key', async () => {
    const h = new Harness();
    const mac = await h.device('user_1');
    const { device_id } = await mac.connect();
    const other = await h.device('user_2');
    // Same key pair, different account.
    Object.assign(other, { keys: Reflect.get(mac, 'keys') });
    other.publicKey = mac.publicKey;
    await expect(other.connect({ deviceId: device_id })).rejects.toThrow(
      /fleet.key_mismatch/,
    );
  });

  it('refuses another protocol version', async () => {
    const h = new Harness();
    const mac = await h.device();
    await mac.open();
    await mac.send(JSON.stringify({ type: 'hello', protocol: 2 }));
    expect(mac.sent[0]).toMatchObject({ type: 'error', code: 'fleet.version' });
    expect(mac.conn.closedWith).toEqual({
      code: 4003,
      reason: 'fleet.version',
    });
  });

  it('wants hello first', async () => {
    const h = new Harness();
    const mac = await h.device();
    await mac.open();
    await mac.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    expect(mac.sent[0]).toMatchObject({ code: 'fleet.bad_message' });
    // Not fatal: the adapter may redial.
    expect(mac.conn.closedWith?.code).toBe(1008);
  });

  it('closes a socket that never says hello', async () => {
    const h = new Harness();
    const mac = await h.device();
    await mac.open();
    await h.tick(9_000);
    expect(mac.conn.open).toBe(true);
    await h.tick(2_000);
    expect(mac.conn.closedWith?.code).toBe(1008);
    expect(mac.sent[0]).toMatchObject({ code: 'fleet.bad_message' });
  });

  it(`registers at most ${MAX_DEVICES_PER_USER} devices per user`, async () => {
    const h = new Harness();
    for (let i = 0; i < MAX_DEVICES_PER_USER; i++) {
      await (await h.device()).connect();
    }
    const extra = await h.device();
    await expect(extra.connect()).rejects.toThrow(/fleet.too_many_devices/);
    expect(extra.conn.closedWith?.code).toBe(4003);
    // Another user isn't affected.
    await (await h.device('user_2')).connect();
  });

  it('pushes devices to the user’s devices only, on every change', async () => {
    const h = new Harness();
    const mac1 = await h.device('user_1', 'mac1');
    const mac2 = await h.device('user_1', 'mac2');
    const stranger = await h.device('user_2', 'theirs');
    await mac1.connect();
    await stranger.connect();
    mac1.clear();
    stranger.clear();
    await mac2.connect();
    const names = (m: typeof mac1) =>
      m
        .take('devices')
        .map((d) => d.devices.map((x) => `${x.info.name}:${x.online}`).sort());
    expect(names(mac1)).toEqual([['mac1:true', 'mac2:true']]);
    expect(names(stranger)).toEqual([]);

    await mac2.send({ type: 'announce', info: info('mac2-renamed') });
    expect(names(mac1)).toEqual([['mac1:true', 'mac2-renamed:true']]);

    h.now += 5_000;
    await mac2.disconnect();
    const [list] = mac1.take('devices');
    const gone = list!.devices.find((d) => d.device_id === mac2.id);
    expect(gone).toMatchObject({ online: false, last_seen_ms: h.now });
  });

  it('resumes the spaces the device hosts', async () => {
    const h = new Harness();
    const mac1 = await h.device();
    const mac2 = await h.device();
    await mac1.connect();
    await mac2.connect();
    const { startSpace } = await import('./fleet-harness');
    await startSpace(mac1, mac2, 'rs_a');
    for (const seq of [1, 2, 3]) {
      await mac2.send({
        type: 'space_event',
        space: 'rs_a',
        seq,
        event: { kind: 'status', status: 'running' },
      });
    }
    await mac2.disconnect();
    expect((await mac2.connect()).resume).toEqual({ rs_a: 3 });
    expect((await mac1.connect()).resume).toEqual({});
  });
});
