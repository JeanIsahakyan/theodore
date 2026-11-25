// Protocol 12: the list comes from the cloud (docs/fleet.md "The list comes
// from the cloud"); the saved set is only a fast cache.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFleetClient } from '../src/fleet/client';
import { open } from '../src/fleet/crypto';
import type { FleetClient } from '../src/fleet/types';
import type { MySpace, RemoteRequest } from '../src/gen/fleet';
import { seedKey } from '../src/keys/ed25519';
import { initialFleet, useFleetState } from '../src/state/fleet';
import {
  CLOUD,
  HOST,
  ME,
  NONCE,
  OTHER,
  TIMING,
  device,
  fakeAuth,
  fakePlatform,
  handshake,
  hostKey,
  sealAs,
  sleep,
  waitFor,
} from './fake-hub';

const myKey = seedKey(new Uint8Array(32).fill(1));
const keys = { deviceKey: async () => myKey, forget: async () => {} };
const state = () => useFleetState.getState();
let clients: FleetClient[] = [];

function setup(platform?: Parameters<typeof fakePlatform>[0]) {
  const hub = fakePlatform(platform);
  const client = createFleetClient(fakeAuth().auth, keys, {
    platform: hub.platform,
    cloudUrl: CLOUD,
    timing: TIMING,
    random: () => 0.5,
  });
  clients.push(client);
  return { hub, client };
}

const row = (space: string, over: Partial<MySpace> = {}): MySpace => ({
  space,
  host_device: HOST,
  origin_device: ME,
  name: null,
  mode: null,
  status: null,
  last_seq: 3,
  last_ms: 1_700_000_000_000,
  ...over,
});

const event = (space: string, seq: number, ev: object) =>
  sealAs({ space, seq, host_device: HOST, event: ev }, HOST, hostKey, 'event');

/** The request the client sent last, opened with this device's key. */
function lastRequest(
  sock: ReturnType<ReturnType<typeof fakePlatform>['last']>,
) {
  const reqs = sock.of('request');
  return open(
    reqs.at(-1)!.envelope,
    myKey.publicKey,
    'request',
  ) as RemoteRequest;
}

async function connected() {
  const t = setup();
  await t.client.start();
  const sock = await handshake(t.hub, [device(HOST, hostKey)]);
  await waitFor(() => state().devices.length === 1, 'devices');
  await t.client.trust(HOST, hostKey.publicKey);
  return { ...t, sock };
}

beforeEach(() => useFleetState.setState(initialFleet, true));
afterEach(() => {
  clients.forEach((c) => c.stop());
  clients = [];
});

describe('my_spaces', () => {
  it('lists and subscribes what the cloud says when nothing was saved', async () => {
    const { sock } = await connected();
    expect(state().spaces).toEqual([]);
    sock.deliver({
      type: 'my_spaces',
      list: [
        row('rs_1', { name: 'Fix login', mode: 'edit', status: 'running' }),
        row('rs_2'),
        // Not a space a host issues, or no device ids: dropped.
        row('../etc'),
        { space: 'rs_3', host_device: 'mac' },
      ],
    });
    await waitFor(() => state().spaces.length === 2, 'listed');
    expect(
      state()
        .spaces.map((s) => s.space)
        .sort(),
    ).toEqual(['rs_1', 'rs_2']);
    const one = state().spaces.find((s) => s.space === 'rs_1')!;
    expect(one).toMatchObject({
      hostDevice: HOST,
      originDevice: ME,
      name: 'Fix login',
      mode: 'edit',
      status: 'running',
      startedHere: true,
    });
    // No title from the cloud: a placeholder until the host's rows arrive.
    expect(state().spaces.find((s) => s.space === 'rs_2')!.name).toBe('');
    expect(sock.of('subscribe')).toEqual([
      { type: 'subscribe', space: 'rs_1', since: 0 },
      { type: 'subscribe', space: 'rs_2', since: 0 },
    ]);
    // The host's signed `started` replaces the cloud's word.
    sock.deliver({
      type: 'space_event',
      envelope: await event('rs_2', 1, {
        kind: 'started',
        host_device: HOST,
        origin_device: ME,
        project_id: 'p1',
        project_name: 'Theodore',
        name: 'Port the parser',
        branch: 'th/port',
        mode: 'plan',
        depth: 0,
      }),
    });
    await waitFor(
      () => state().spaces.find((s) => s.space === 'rs_2')!.name !== '',
      'named',
    );
    expect(state().spaces.find((s) => s.space === 'rs_2')).toMatchObject({
      name: 'Port the parser',
      projectName: 'Theodore',
      mode: 'plan',
    });
  });

  it('merges without duplicates and never drops a space for missing', async () => {
    const { sock } = await connected();
    sock.deliver({ type: 'my_spaces', list: [row('rs_1')] });
    await waitFor(() => state().spaces.length === 1, 'one');
    sock.deliver({ type: 'my_spaces', list: [row('rs_1'), row('rs_2')] });
    await waitFor(() => state().spaces.length === 2, 'two');
    sock.deliver({ type: 'my_spaces', list: [row('rs_2')] });
    await sleep(10);
    expect(
      state()
        .spaces.map((s) => s.space)
        .sort(),
    ).toEqual(['rs_1', 'rs_2']);
    // Each subscribed once.
    expect(sock.of('subscribe').map((s) => s.space)).toEqual(['rs_1', 'rs_2']);
  });

  it('lists a delegator’s space as followed', async () => {
    const { sock } = await connected();
    sock.deliver({
      type: 'my_spaces',
      list: [row('rs_far', { origin_device: OTHER })],
    });
    await waitFor(() => state().spaces.length === 1, 'listed');
    expect(state().spaces[0]).toMatchObject({
      originDevice: OTHER,
      startedHere: false,
    });
  });

  it('is saved, so the next launch lists it before the socket', async () => {
    const { hub, sock } = await connected();
    sock.deliver({ type: 'my_spaces', list: [row('rs_1', { name: 'Kept' })] });
    await waitFor(() => state().spaces.length === 1, 'listed');
    hub.setActive(false);
    await waitFor(() => true);
    await sleep(20);
    clients.forEach((c) => c.stop());
    useFleetState.setState(initialFleet, true);
    const r = setup({ storage: hub.storage, data: hub.data });
    await r.client.start();
    expect(state().spaces.map((s) => [s.space, s.name])).toEqual([
      ['rs_1', 'Kept'],
    ]);
  });

  it('asks again after an adopt: the welcome’s list predates the move', async () => {
    const NEW = 'dev_00000000-0000-4000-8000-0000000000d4';
    const { hub, client } = setup();
    await hub.storage.set('theodore.fleet.device_id.org_test', ME);
    await client.start();
    await waitFor(() => hub.sockets.length >= 1, 'a socket');
    const s = hub.last();
    s.deliver({ type: 'challenge', nonce: NONCE });
    await waitFor(() => s.of('hello').length === 1, 'hello');
    s.deliver({ type: 'welcome', device_id: NEW, generation: 1, resume: {} });
    await waitFor(() => s.of('list_my_spaces').length === 1, 'asked again');
    const types = s.sent.map((m) => m.type);
    expect(types.indexOf('adopt')).toBeLessThan(
      types.indexOf('list_my_spaces'),
    );
  });
});

describe('refresh and the computers’ own spaces', () => {
  const listing = (spaces: object[]) => ({
    note: 'other spaces',
    truncated: false,
    spaces,
  });
  const item = (space: string, over: object = {}) => ({
    space,
    name: space,
    title: `Title ${space}`,
    project: 'theodore',
    status: 'idle',
    mode: 'edit',
    agent: 'claude',
    turns: 1,
    remote: false,
    done: false,
    updated_at: 10,
    ...over,
  });

  async function answerList(
    sock: ReturnType<ReturnType<typeof fakePlatform>['last']>,
    value: object,
  ) {
    await waitFor(
      () =>
        sock.of('request').some((r) => r.envelope.body.includes('list_spaces')),
      'list_spaces',
    );
    const req = lastRequest(sock);
    expect(req.op).toEqual({ op: 'list_spaces', project: null });
    sock.deliver({
      type: 'reply',
      envelope: await sealAs(
        {
          req_id: req.req_id,
          origin_device: req.origin_device,
          target_device: HOST,
          outcome: { outcome: 'ok', value },
        },
        HOST,
        hostKey,
        'reply',
      ),
    });
  }

  it('lists a trusted computer’s other spaces, without those followed here', async () => {
    const { client, sock } = await connected();
    sock.deliver({ type: 'my_spaces', list: [row('rs_1')] });
    sock.deliver({
      type: 'space_event',
      envelope: await event('rs_1', 1, {
        kind: 'started',
        host_device: HOST,
        origin_device: ME,
        project_id: 'p1',
        project_name: 'Theodore',
        name: 'mine',
        branch: 'th/mine',
        mode: 'edit',
        depth: 0,
      }),
    });
    await waitFor(() => state().spaces[0]?.name === 'mine', 'named');
    sock.sent = [];
    const done = client.refreshSpaces();
    expect(state().refreshing).toBe(true);
    expect(sock.of('list_my_spaces')).toHaveLength(1);
    await answerList(
      sock,
      listing([
        item('a1b2c3d4e5f6', { updated_at: 20 }),
        item('mine'),
        item('0000000000aa', { remote: true }),
        item('0000000000bb', { done: true }),
        item('0000000000cc', { parent: { space: 'x', title: 'X' } }),
        item('../bad'),
        item('0000000000dd', { status: 'running', updated_at: 30 }),
      ]),
    );
    await done;
    expect(state().refreshing).toBe(false);
    expect(
      state().computerSpaces.map((c) => [c.space, c.hostDevice, c.status]),
    ).toEqual([
      ['0000000000dd', HOST, 'running'],
      ['a1b2c3d4e5f6', HOST, 'idle'],
    ]);
    expect(state().computerSpaces[1]!.title).toBe('Title a1b2c3d4e5f6');
  });

  it('asks the computers once the devices are listed, and only trusted ones', async () => {
    const t = setup();
    await t.client.start();
    const sock = await handshake(t.hub, [device(HOST, hostKey)]);
    await sleep(20);
    // Not trusted here: nothing asked.
    expect(sock.of('request')).toEqual([]);
    await t.client.trust(HOST, hostKey.publicKey);
    await t.client.refreshSpaces();
    // The reply never comes: it times out, the list stays empty.
    expect(state().computerSpaces).toEqual([]);
    expect(sock.of('request')).toHaveLength(1);
  });

  it('does nothing without a welcomed link', async () => {
    const { client, hub } = setup();
    await client.refreshSpaces();
    expect(hub.sockets.flatMap((s) => s.sent)).toEqual([]);
    expect(state().refreshing).toBe(false);
  });
});
