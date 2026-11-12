import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { RemoteAsk } from '../src/gen/fleet';
import {
  HOST_OFFLINE_PRUNE_MS,
  MAX_SPACES_PER_USER,
} from '../src/fleet/limits';
import { SCHEMA_VERSION } from '../src/fleet/store';
import {
  FakeConn,
  Harness,
  startOp,
  startSpace,
  type Device,
} from './fleet-harness';

async function trio() {
  const h = new Harness();
  const mac1 = await h.device('user_1', 'mac1');
  const mac2 = await h.device('user_1', 'mac2');
  const mac3 = await h.device('user_1', 'mac3');
  for (const d of [mac1, mac2, mac3]) await d.connect();
  return { h, mac1, mac2, mac3 };
}

const count = (h: Harness, table: string) =>
  (h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).all()[0] as { n: number })
    .n;

const replyCodes = (d: Device) =>
  d
    .take('reply')
    .map((r) => (r.outcome.outcome === 'err' ? r.outcome.code : 'ok'));

/** `n` spaces mac1 started on mac2, paced under the rate limit. */
async function fill(h: Harness, mac1: Device, mac2: Device, n: number) {
  for (let i = 0; i < n; i++) {
    h.now += 100;
    await startSpace(mac1, mac2, `rs_${i}`);
  }
}

describe('fleet space cap', () => {
  it(`refuses a start past ${MAX_SPACES_PER_USER} spaces, pending ones counted`, async () => {
    const { h, mac1, mac2 } = await trio();
    await fill(h, mac1, mac2, MAX_SPACES_PER_USER - 1);
    mac2.clear();
    await mac1.request(mac2.id!, startOp('rs_pending'));
    expect(mac2.take('request')).toHaveLength(1);
    await mac1.request(mac2.id!, startOp('rs_over'));
    expect(replyCodes(mac1)).toEqual(['fleet.too_many_spaces']);
    expect(mac2.take('request')).toEqual([]);
    // Another user isn't affected.
    const a = await h.device('user_2', 'a');
    const b = await h.device('user_2', 'b');
    await a.connect();
    await b.connect();
    await startSpace(a, b, 'rs_theirs');
  });

  it('makes room by forgetting the oldest finished space', async () => {
    const { h, mac1, mac2 } = await trio();
    await fill(h, mac1, mac2, MAX_SPACES_PER_USER);
    h.now += 1_000;
    await mac2.emit('rs_5', 1, { kind: 'status', status: 'stopped' });
    h.now += 1_000;
    await mac2.emit('rs_3', 1, { kind: 'status', status: 'failed' });
    await mac2.emit('rs_1', 1, { kind: 'status', status: 'idle' });
    mac2.clear();
    await startSpace(mac1, mac2, 'rs_new');
    // rs_5 finished first: gone with its events. rs_3 and idle rs_1 stay.
    await mac1.send({ type: 'subscribe', space: 'rs_5', since: 0 });
    expect(mac1.take('error')[0]?.code).toBe('fleet.not_yours');
    for (const sp of ['rs_3', 'rs_1', 'rs_new']) {
      await mac1.send({ type: 'subscribe', space: sp, since: 0 });
    }
    expect(mac1.take('error')).toEqual([]);
    expect(count(h, 'spaces')).toBe(MAX_SPACES_PER_USER);
    expect(count(h, 'events')).toBe(2);
    // Next time, rs_3 goes.
    await startSpace(mac1, mac2, 'rs_new2');
    await mac1.send({ type: 'subscribe', space: 'rs_3', since: 0 });
    expect(mac1.take('error')[0]?.code).toBe('fleet.not_yours');
    // Nothing finished left: refused.
    await mac1.request(mac2.id!, startOp('rs_new3'));
    expect(replyCodes(mac1)).toEqual(['fleet.too_many_spaces']);
  });
});

describe('fleet pruning', () => {
  async function hosted() {
    const t = await trio();
    await startSpace(t.mac1, t.mac2, 'rs_1');
    await t.mac2.emit('rs_1', 1, { kind: 'status', status: 'running' });
    t.mac1.clear();
    return t;
  }

  it('forgets spaces whose host has been offline for 30 days', async () => {
    const { h, mac1, mac2 } = await hosted();
    await mac2.disconnect();
    h.now += HOST_OFFLINE_PRUNE_MS - 60_000;
    await mac1.connect();
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    expect(mac1.take('error')).toEqual([]);
    h.now += 120_000;
    await mac1.connect();
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    expect(mac1.take('error')[0]?.code).toBe('fleet.not_yours');
    expect(count(h, 'events')).toBe(0);
    expect(count(h, 'subs')).toBe(0);
  });

  it('keeps the spaces of a host that is online, or just came back', async () => {
    const { h, mac1, mac2, mac3 } = await hosted();
    h.now += HOST_OFFLINE_PRUNE_MS + 60_000;
    await mac3.connect(); // mac2 still connected: kept
    expect(count(h, 'spaces')).toBe(1);
    await mac2.disconnect();
    await mac1.disconnect();
    await mac3.disconnect();
    h.now += HOST_OFFLINE_PRUNE_MS + 60_000;
    // Its own hello moves its last_seen before anything is pruned.
    expect((await mac2.connect()).resume).toEqual({ rs_1: 1 });
  });
});

describe('fleet remove_device', () => {
  it('forgets the device, its spaces, and closes its socket', async () => {
    const { h, mac1, mac2, mac3 } = await trio();
    await startSpace(mac1, mac2, 'rs_1');
    await mac2.emit('rs_1', 1, { kind: 'status', status: 'running' });
    await mac2.raise(ask(mac2.id!));
    expect(mac1.take('ask')).toHaveLength(1);
    await mac2.disconnect();
    await mac2.connect();
    await mac3.request(mac2.id!, startOp('rs_2')); // waiting for mac2
    for (const d of [mac1, mac2, mac3]) d.clear();
    const conn = mac2.conn;

    await mac1.send({ type: 'remove_device', device_id: mac2.id! });

    expect(mac2.take('error')[0]?.code).toBe('fleet.removed');
    expect(conn.closedWith).toEqual({ code: 4003, reason: 'fleet.removed' });
    const [list] = mac3.take('devices');
    expect(list!.devices.map((d) => d.device_id).sort()).toEqual(
      [mac1.id!, mac3.id!].sort(),
    );
    expect(mac1.take('dismiss').map((d) => d.reason)).toEqual(['resolved']);
    expect(replyCodes(mac3)).toEqual(['fleet.offline']);
    expect(count(h, 'spaces')).toBe(0);
    expect(count(h, 'events')).toBe(0);
    expect(count(h, 'asks')).toBe(0);
    expect(count(h, 'pending')).toBe(0);
    await h.hub.closed(conn); // its close event: nothing left to clean
    // The same key comes back only as a new device.
    const old = mac2.id;
    const welcome = await mac2.connect();
    expect(welcome.device_id).not.toBe(old);
    expect(welcome.resume).toEqual({});
  });

  it('refuses the calling device itself, another user’s, an unknown one', async () => {
    const { h, mac1 } = await trio();
    const theirs = await h.device('user_2', 'theirs');
    await theirs.connect();
    mac1.clear();
    for (const id of [mac1.id!, theirs.id!, 'dev_nope']) {
      await mac1.send({ type: 'remove_device', device_id: id });
    }
    expect(mac1.take('error').map((e) => e.code)).toEqual([
      'fleet.invalid',
      'fleet.not_yours',
      'fleet.not_yours',
    ]);
    expect(mac1.conn.open).toBe(true);
    expect(theirs.conn.open).toBe(true);
  });
});

describe('fleet schema', () => {
  it('drops v1 relay state, keeping devices', async () => {
    const db = new DatabaseSync(':memory:');
    db.prepare(
      `CREATE TABLE devices (device_id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      public_key TEXT NOT NULL, info TEXT NOT NULL, generation INTEGER NOT NULL,
      last_seen_ms INTEGER NOT NULL)`,
    ).all();
    db.prepare(
      `CREATE TABLE events (space TEXT NOT NULL, seq INTEGER NOT NULL,
      event TEXT NOT NULL, PRIMARY KEY (space, seq))`,
    ).all();
    db.prepare(
      `INSERT INTO devices VALUES ('dev_old', 'user_9', 'k', '{}', 1, 0)`,
    ).all();
    db.prepare(
      `INSERT INTO events VALUES ('rs_old', 1, '{"kind":"status"}')`,
    ).all();
    const h = new Harness(db);
    const mac = await h.device();
    const { device_id } = await mac.connect();
    expect(count(h, 'events')).toBe(0);
    expect(count(h, 'devices')).toBe(2);
    const cols = db.prepare('PRAGMA table_info(events)').all() as {
      name: string;
    }[];
    expect(cols.map((c) => c.name)).toContain('envelope');
    expect(
      db.prepare("SELECT v FROM meta WHERE k = 'schema'").all()[0],
    ).toEqual({ v: SCHEMA_VERSION });

    // A wake under the same schema keeps everything.
    const again = new Harness(db);
    const same = await again.device();
    Object.assign(same, { keys: Reflect.get(mac, 'keys') });
    same.publicKey = mac.publicKey;
    expect((await same.connect({ deviceId: device_id })).device_id).toBe(
      device_id,
    );
  });
});

describe('fleet sockets before open', () => {
  it('ignore a socket the runtime accepted but `open` hasn’t reached', async () => {
    const { h, mac1, mac2 } = await trio();
    h.conns.push(new FakeConn('user_1')); // no state yet
    await startSpace(mac1, mac2, 'rs_1');
    await mac1.send({
      type: 'presence',
      focused: true,
      locked: false,
      idle_ms: 0,
    });
    await mac2.raise(ask(mac2.id!));
    expect(mac1.take('ask').map((a) => a.via)).toEqual(['active']);
  });
});

function ask(host: string): RemoteAsk {
  return {
    ask_id: 'ask_x',
    space: 'rs_1',
    host_device: host,
    from: 'mac2 · S',
    questions: [{ question: 'Which?', options: ['a'], multi: false }],
  };
}
