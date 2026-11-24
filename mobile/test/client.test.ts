import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFleetClient } from '../src/fleet/client';
import { domainMessage, open } from '../src/fleet/crypto';
import type { FleetClient } from '../src/fleet/types';
import type { RemoteRequest, SignedEnvelope } from '../src/gen/fleet';
import { fromBase64, utf8 } from '../src/keys/base64';
import { seedKey, verifySignature } from '../src/keys/ed25519';
import { fingerprint } from '../src/keys/fingerprint';
import { seedKeyStore } from '../src/keys/seed-store';
import { memoryStorage } from '../src/keys/storage-types';
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
  originKey,
  sealAs,
  session,
  sleep,
  strangerKey,
  waitFor,
} from './fake-hub';

const myKey = seedKey(new Uint8Array(32).fill(1));
const keys = {
  deviceKey: async () => myKey,
  forget: async () => {},
};
const state = () => useFleetState.getState();

let clients: FleetClient[] = [];

function setup(
  opts: {
    platform?: Parameters<typeof fakePlatform>[0];
    auth?: ReturnType<typeof fakeAuth>;
    fetch?: typeof fetch;
  } = {},
) {
  const hub = fakePlatform(opts.platform);
  const account = opts.auth ?? fakeAuth();
  const client = createFleetClient(account.auth, keys, {
    platform: hub.platform,
    cloudUrl: CLOUD,
    timing: TIMING,
    random: () => 0.5,
    fetch: opts.fetch,
  });
  clients.push(client);
  return { hub, account, client };
}

/** Connected, with HOST listed and trusted. */
async function connectedWithHost() {
  const t = setup();
  await t.client.start();
  const sock = await handshake(t.hub, [device(HOST, hostKey)]);
  await waitFor(() => state().devices.length === 1, 'devices');
  await t.client.trust(HOST, hostKey.publicKey);
  return { ...t, sock };
}

/** The request the client sent last, opened with this device's key. */
function lastRequest(sock: {
  of: (t: 'request') => { envelope: SignedEnvelope }[];
}) {
  const reqs = sock.of('request');
  const env = reqs[reqs.length - 1]!.envelope;
  const body = open(env, myKey.publicKey, 'request');
  expect(body).not.toBeNull();
  return body as RemoteRequest;
}

function reply(
  req: RemoteRequest,
  outcome: object,
  key = hostKey,
  signer = HOST,
) {
  return sealAs(
    {
      req_id: req.req_id,
      origin_device: req.origin_device,
      target_device: signer,
      outcome,
    },
    signer,
    key,
    'reply',
  );
}

const event = (
  space: string,
  seq: number,
  ev: object,
  key = hostKey,
  domain: 'event' | 'ask' = 'event',
) => sealAs({ space, seq, host_device: HOST, event: ev }, HOST, key, domain);

beforeEach(() => {
  useFleetState.setState(initialFleet, true);
});

afterEach(() => {
  clients.forEach((c) => c.stop());
  clients = [];
});

describe('connect', () => {
  it('says hello as a client device and takes the welcome', async () => {
    const { hub, client } = setup();
    await client.start();
    expect(hub.sockets).toHaveLength(1);
    expect(hub.last().url).toBe('wss://cloud.test/v1/fleet/ws');
    expect(hub.last().token).toBe('tok-1');
    expect(state().connection).toBe('connecting');
    expect(state().welcomed).toBe(false);
    expect(state().fingerprint).toBe(fingerprint(myKey.publicKey));

    const sock = await handshake(hub, [
      device(HOST, hostKey),
      device(ME, myKey, { kind: 'mobile' }),
    ]);
    const hello = sock.of('hello')[0]!;
    expect(hello.protocol).toBe(6);
    expect(hello.device_id).toBeNull();
    expect(hello.public_key).toBe(myKey.publicKey);
    expect(hello.spaces).toEqual([]);
    expect(hello.info).toEqual({
      name: 'Test iPhone',
      os: 'macos',
      kind: 'mobile',
      app_version: '1.0.0',
      projects: [],
      accepts_remote: false,
      max_mode: 'ask',
    });
    expect(
      verifySignature(
        myKey.publicKey,
        domainMessage('hello', fromBase64(NONCE)!),
        hello.signature,
      ),
    ).toBe(true);

    await waitFor(() => state().connection === 'connected', 'connected');
    expect(state().deviceId).toBe(ME);
    await waitFor(() => state().devices.length === 2, 'devices');
    // The first list of this run: Home and the drawer leave loading.
    await waitFor(() => state().welcomed, 'welcomed');
    const host = state().devices.find((d) => d.deviceId === HOST)!;
    expect(host.trusted).toBe(false);
    expect(host.fingerprint).toBe(fingerprint(hostKey.publicKey));
    expect(state().devices.find((d) => d.deviceId === ME)!.thisDevice).toBe(
      true,
    );
    expect(await hub.storage.get('theodore.fleet.device_id.org_test')).toBe(ME);
  });

  it('says hello with the device id it was given for the org', async () => {
    const { hub, client } = setup();
    await hub.storage.set('theodore.fleet.device_id.org_test', ME);
    await client.start();
    const sock = await handshake(hub);
    expect(sock.of('hello')[0]!.device_id).toBe(ME);
  });

  it('drops devices whose id the cloud would never issue', async () => {
    const { hub, client } = setup();
    await client.start();
    await handshake(hub, [
      device(HOST, hostKey),
      device('dev_evil', strangerKey),
    ]);
    await waitFor(() => state().devices.length > 0, 'devices');
    expect(state().devices.map((d) => d.deviceId)).toEqual([HOST]);
  });

  it('signs nothing but a 32-byte nonce, and only once per socket', async () => {
    const { hub, client } = setup();
    await client.start();
    const first = hub.last();
    first.deliver({ type: 'challenge', nonce: 'AAAA' });
    await waitFor(() => first.closed !== null, 'socket dropped');
    expect(first.of('hello')).toHaveLength(0);

    await waitFor(() => hub.sockets.length === 2, 'redial');
    const second = hub.last();
    second.deliver({ type: 'challenge', nonce: NONCE });
    await waitFor(() => second.of('hello').length === 1, 'hello');
    second.deliver({ type: 'challenge', nonce: NONCE });
    await waitFor(() => second.closed !== null, 'second challenge drops');
    expect(second.of('hello')).toHaveLength(1);
  });

  it('ignores frames before the welcome and a welcome before hello', async () => {
    const { hub, client } = setup();
    await client.start();
    const s = hub.last();
    s.deliver({ type: 'devices', devices: [device(HOST, hostKey)] });
    s.deliver({ type: 'welcome', device_id: ME, generation: 1, resume: {} });
    await waitFor(() => s.closed !== null, 'dropped');
    expect(state().devices).toEqual([]);
    expect(state().connection).not.toBe('connected');
  });

  it('redials after a drop and subscribes again from the last seq', async () => {
    const { hub, client, sock } = await connectedWithHost();
    const started = client.startSpace({
      deviceId: HOST,
      projectId: 'p1',
      goal: 'fix it',
      mode: 'edit',
    });
    await waitFor(() => sock.of('request').length === 1, 'request');
    const req = lastRequest(sock);
    sock.deliver({
      type: 'reply',
      envelope: await reply(req, {
        outcome: 'ok',
        value: { space: 'x', name: 'n', branch: 'b' },
      }),
    });
    const view = await started;
    sock.deliver({
      type: 'space_event',
      envelope: await event(view.space, 1, {
        kind: 'status',
        status: 'running',
      }),
    });
    sock.deliver({
      type: 'space_event',
      envelope: await event(view.space, 2, {
        kind: 'reply',
        turn: 1,
        text: 'hi',
      }),
    });
    await waitFor(
      () => (state().lines[view.space] ?? []).length === 2,
      'lines',
    );

    sock.drop(1006);
    expect(state().connection).toBe('connecting');
    const again = await handshake(hub, [device(HOST, hostKey)], 2);
    await waitFor(() => again.of('subscribe').length === 1, 'resubscribe');
    expect(again.of('subscribe')[0]).toEqual({
      type: 'subscribe',
      space: view.space,
      since: 2,
    });
    expect(state().connection).toBe('connected');
  });

  it('reauths with a refreshed token, and the welcome catches up a token changed mid-handshake', async () => {
    const { hub, client, account } = setup();
    await client.start();
    const s = hub.last();
    s.deliver({ type: 'challenge', nonce: NONCE });
    await waitFor(() => s.of('hello').length === 1, 'hello');
    account.emit(session('tok-2'));
    s.deliver({ type: 'welcome', device_id: ME, generation: 1, resume: {} });
    await waitFor(() => s.of('reauth').length === 1, 'catch-up reauth');
    expect(s.of('reauth')[0]!.access_token).toBe('tok-2');

    account.emit(session('tok-3'));
    expect(s.of('reauth').map((m) => m.access_token)).toEqual([
      'tok-2',
      'tok-3',
    ]);
    account.emit(session('tok-3'));
    expect(s.of('reauth')).toHaveLength(2);
    expect(hub.sockets).toHaveLength(1);
  });

  it('stops for good on a fatal close; start() or a new token tries again', async () => {
    const { hub, client, account } = setup();
    await client.start();
    const s = await handshake(hub);
    s.drop(4003, 'fleet.key_mismatch');
    expect(state().connection).toBe('error');
    expect(state().error).toContain('fleet.key_mismatch');
    await sleep(60);
    expect(hub.sockets).toHaveLength(1);

    account.emit(session('tok-1')); // same token: still fatal
    await sleep(20);
    expect(hub.sockets).toHaveLength(1);
    account.emit(session('tok-2'));
    await waitFor(() => hub.sockets.length === 2, 'redial on a new token');

    const t = await handshake(hub, [], 2);
    t.deliver({
      type: 'error',
      code: 'fleet.unauthorized',
      message: '<script>',
    });
    await waitFor(() => state().connection === 'error', 'fatal error frame');
    expect(state().error).not.toContain('<script>');
    await sleep(60);
    expect(hub.sockets).toHaveLength(2);
    await client.start();
    expect(hub.sockets).toHaveLength(3);
  });

  it('treats an unknown 4001 reason as unauthorized and forgets the id on removed', async () => {
    const { hub, client } = setup();
    await client.start();
    let s = await handshake(hub);
    s.drop(4001, 'whatever');
    expect(state().error).toContain('fleet.unauthorized');

    await client.start();
    s = await handshake(hub, [], 2);
    expect(await hub.storage.get('theodore.fleet.device_id.org_test')).toBe(ME);
    s.deliver({ type: 'error', code: 'fleet.removed', message: '' });
    await waitFor(() => state().connection === 'error', 'fatal');
    await sleep(5);
    expect(
      await hub.storage.get('theodore.fleet.device_id.org_test'),
    ).toBeNull();
  });

  it('closes on sign-out and clears what was shown; signs in again on its own', async () => {
    const { hub, account, sock } = await connectedWithHost();
    expect(state().devices).toHaveLength(1);
    account.emit(null);
    expect(sock.closed).not.toBeNull();
    expect(state().connection).toBe('off');
    expect(state().devices).toEqual([]);
    expect(state().fingerprint).toBe(fingerprint(myKey.publicKey));
    account.emit(session('tok-9'));
    await waitFor(() => hub.sockets.length === 2, 'new link after sign-in');
    expect(hub.last().token).toBe('tok-9');
  });

  it('switches org: new link, nothing of the old org kept', async () => {
    const { hub, account, sock } = await connectedWithHost();
    account.emit(session('tok-1', 'org_other'));
    expect(sock.closed).not.toBeNull();
    await waitFor(() => hub.sockets.length === 2, 'new link');
    const s = hub.last();
    s.deliver({ type: 'challenge', nonce: NONCE });
    await waitFor(() => s.of('hello').length === 1, 'hello');
    expect(s.of('hello')[0]!.device_id).toBeNull();
  });

  it('switches account: new link as it, the old one’s set kept, requests in flight dropped', async () => {
    const t = await runningSpace();
    const { hub, account, sock, client, space } = t;
    // Going to the background saves now.
    hub.setActive(false);
    hub.setActive(true);
    const end = Date.now() + 1500;
    while (
      (await hub.data.get('theodore.fleet.spaces.user_1.org_test')) === null
    ) {
      if (Date.now() > end) throw new Error('timed out waiting for the save');
      await sleep(2);
    }
    // A send waits for the host's word when the account changes.
    const sending = client.send(space, 'hello');
    await waitFor(() => sock.of('request').length === 2, 'send request');
    account.emit({ ...session('tok-b', 'org_test'), userId: 'user_2' });
    expect(sock.closed).not.toBeNull();
    await expect(sending).rejects.toThrow(/didn't answer in time/);
    // Nothing of user_1's fleet stays shown; the new link dials with user_2's token.
    expect(state().spaces).toEqual([]);
    expect(state().welcomed).toBe(false);
    await waitFor(() => hub.sockets.length === 2, 'new link');
    expect(hub.last().token).toBe('tok-b');
    // user_1's saved set is still there for when it is back.
    expect(
      await hub.data.get('theodore.fleet.spaces.user_1.org_test'),
    ).not.toBeNull();
    // Until the account itself leaves this device.
    await client.forgetSaved(['user_1.org_test']);
    expect(
      await hub.data.get('theodore.fleet.spaces.user_1.org_test'),
    ).toBeNull();
  });

  it('drops the push token in the connected org without forgetting it', async () => {
    const { hub, account, sock, client } = await connectedWithHost();
    await client.registerPush('ExponentPushToken[x]');
    expect(sock.of('register_push').at(-1)?.token).toBe('ExponentPushToken[x]');
    await client.dropPushHere();
    expect(sock.of('register_push').at(-1)?.token).toBe('');
    // The next account's link registers the same token again at its welcome.
    account.emit({ ...session('tok-b', 'org_test'), userId: 'user_2' });
    const s2 = await handshake(hub, [], 2);
    await waitFor(() => s2.of('register_push').length === 1, 'push again');
    expect(s2.of('register_push').map((m) => m.token)).toEqual([
      'ExponentPushToken[x]',
    ]);
  });

  it('refuses to dial without an organization', async () => {
    const { hub, client } = setup({ auth: fakeAuth(session('t', null)) });
    await client.start();
    expect(hub.sockets).toHaveLength(0);
    expect(state().error).toContain('fleet.no_org');
  });

  it('on iOS closes in the background and redials on foreground', async () => {
    const { hub, client } = setup({ platform: { closeInBackground: true } });
    await client.start();
    const s = await handshake(hub);
    hub.setActive(false);
    expect(s.closed).not.toBeNull();
    expect(state().connection).toBe('off');
    await sleep(40);
    expect(hub.sockets).toHaveLength(1);
    hub.setActive(true);
    await waitFor(() => hub.sockets.length === 2, 'redial on foreground');
  });

  it('replaced by another tab (4000): holds off, says so, takes it back in front', async () => {
    const { hub, client, account } = setup();
    await client.start();
    const s = await handshake(hub);
    await waitFor(() => state().connection === 'connected', 'connected');
    s.drop(4000, 'replaced by a newer connection');
    expect(state().connection).toBe('error');
    expect(state().error).toContain('another tab or window');
    // No redial loop: not after the backoff, not on a token refresh.
    await sleep(60);
    account.emit(session('tok-2'));
    await sleep(20);
    expect(hub.sockets).toHaveLength(1);

    hub.setActive(false);
    hub.setActive(true);
    await handshake(hub, [], 2);
    await waitFor(() => state().connection === 'connected', 'back');
    expect(hub.sockets).toHaveLength(2);
  });

  it('replaced (4000), start() dials again', async () => {
    const { hub, client } = setup();
    await client.start();
    const s = await handshake(hub);
    s.drop(4000);
    await sleep(30);
    expect(hub.sockets).toHaveLength(1);
    await client.start();
    expect(hub.sockets).toHaveLength(2);
  });

  it('two clients in one JS context: the replaced one goes quiet for good', async () => {
    const a = setup();
    await a.client.start();
    const sa = await handshake(a.hub);
    // A second client (a dev reload) on the same device and org.
    const b = setup();
    await b.client.start();
    await handshake(b.hub);
    await waitFor(() => state().connection === 'connected', 'b connected');
    sa.drop(4000, 'replaced by a newer connection');
    await sleep(60);
    expect(a.hub.sockets).toHaveLength(1);
    // The store is the live one's: nothing written over it.
    expect(state().connection).toBe('connected');
    expect(state().error).toBeNull();
    a.hub.setActive(true);
    await a.client.start();
    await sleep(20);
    expect(a.hub.sockets).toHaveLength(1);
  });

  it('pings on native sockets', async () => {
    let pings = 0;
    const hub = fakePlatform();
    const native = createFleetClient(fakeAuth().auth, keys, {
      platform: {
        ...hub.platform,
        openSocket(url, token) {
          const s = hub.platform.openSocket(url, token);
          (s as { ping?: () => void }).ping = () => pings++;
          return s;
        },
      },
      cloudUrl: CLOUD,
      timing: { ...TIMING, pingEveryMs: 10 },
    });
    clients.push(native);
    await native.start();
    await waitFor(() => pings >= 2, 'pings');
  });

  it('sends the push token after each welcome', async () => {
    const { hub, client } = setup();
    await client.registerPush('ExponentPushToken[x]');
    await client.start();
    const s = await handshake(hub);
    await waitFor(() => s.of('register_push').length === 1, 'push');
    expect(s.of('register_push')[0]).toEqual({
      type: 'register_push',
      provider: 'expo',
      token: 'ExponentPushToken[x]',
    });
    await client.registerPush(null);
    expect(s.of('register_push')[1]!.token).toBe('');
  });
});

describe('trust', () => {
  it('pins exactly the key the cloud lists now, with a sanitized name', async () => {
    const { hub, client } = setup();
    await client.start();
    await handshake(hub, [device(HOST, hostKey)]);
    await waitFor(() => state().devices.length === 1, 'devices');
    await expect(client.trust(HOST, strangerKey.publicKey)).rejects.toThrow(
      /changed/,
    );
    await expect(client.trust(OTHER, hostKey.publicKey)).rejects.toThrow(
      /isn't in/,
    );
    await client.trust(HOST, hostKey.publicKey);
    const d = state().devices[0]!;
    expect(d.trusted).toBe(true);
    expect(d.name).toBe('Mac bStudiob');
    await client.untrust(HOST);
    expect(state().devices[0]!.trusted).toBe(false);
  });

  it('shows a device untrusted once its listed key changes', async () => {
    const { sock } = await connectedWithHost();
    expect(state().devices[0]!.trusted).toBe(true);
    sock.deliver({ type: 'devices', devices: [device(HOST, strangerKey)] });
    await waitFor(() => state().devices[0]?.trusted === false, 'untrusted');
  });
});

describe('start a space', () => {
  it('only on a trusted computer with the key it was trusted with', async () => {
    const { hub, client } = setup();
    await client.start();
    const sock = await handshake(hub, [
      device(HOST, hostKey),
      device(OTHER, strangerKey, { kind: 'mobile' }),
    ]);
    await waitFor(() => state().devices.length === 2, 'devices');
    const go = (deviceId: string) =>
      client.startSpace({ deviceId, projectId: 'p1', goal: 'x', mode: 'edit' });
    await expect(go(HOST)).rejects.toThrow(/isn't trusted/);
    await client.trust(OTHER, strangerKey.publicKey);
    await expect(go(OTHER)).rejects.toThrow(/only a computer/);
    await client.trust(HOST, hostKey.publicKey);
    sock.deliver({ type: 'devices', devices: [device(HOST, strangerKey)] });
    await waitFor(() => state().devices[0]?.trusted === false, 'key changed');
    await expect(go(HOST)).rejects.toThrow(/key changed/);
    await expect(
      client.startSpace({
        deviceId: HOST,
        projectId: 'p1',
        goal: '  ',
        mode: 'ask',
      }),
    ).rejects.toThrow(/say what/);
    expect(sock.of('request')).toHaveLength(0);
    expect(state().spaces).toEqual([]);
  });

  it('seals the start for the pinned key and subscribes after a verified ok', async () => {
    const { client, sock } = await connectedWithHost();
    const started = client.startSpace({
      deviceId: HOST,
      projectId: 'p1',
      goal: ' fix the bug ',
      mode: 'edit',
    });
    await waitFor(() => sock.of('request').length === 1, 'request');
    const req = lastRequest(sock);
    expect(req.req_id).toMatch(/^req_[0-9a-f-]{36}$/);
    expect(req.origin_device).toBe(ME);
    expect(req.target_device).toBe(HOST);
    expect(req.target_key).toBe(hostKey.publicKey);
    expect(Math.abs(req.issued_at_ms - Date.now())).toBeLessThan(5000);
    expect(req.op).toMatchObject({
      op: 'start_space',
      project_id: 'p1',
      goal: 'fix the bug',
      mode: 'edit',
      depth: 0,
    });
    const space = (req.op as { space: string }).space;
    expect(space).toMatch(/^rs_[0-9a-f]{32}$/);
    expect(state().spaces[0]).toMatchObject({
      space,
      status: 'starting',
      hostName: 'Mac bStudiob',
      startedHere: true,
    });
    expect(sock.of('subscribe')).toHaveLength(0);

    sock.deliver({
      type: 'reply',
      envelope: await reply(req, {
        outcome: 'ok',
        value: { space, name: 'Fix bug', branch: 'th/fix' },
      }),
    });
    const view = await started;
    expect(view).toMatchObject({
      space,
      status: 'running',
      name: 'Fix bug',
      branch: 'th/fix',
      error: null,
    });
    expect(sock.of('subscribe')).toEqual([
      { type: 'subscribe', space, since: 0 },
    ]);
  });

  it('names no agent, model or effort unless picked', async () => {
    const { client, sock } = await connectedWithHost();
    void client
      .startSpace({ deviceId: HOST, projectId: 'p1', goal: 'x', mode: 'ask' })
      .catch(() => {});
    await waitFor(() => sock.of('request').length === 1, 'request');
    expect(lastRequest(sock).op).toMatchObject({
      op: 'start_space',
      agent: null,
      model: null,
      effort: null,
    });

    void client
      .startSpace({
        deviceId: HOST,
        projectId: 'p1',
        goal: 'y',
        mode: 'ask',
        agent: 'claude',
        model: 'claude-opus-4-1',
        effort: 'xhigh',
      })
      .catch(() => {});
    await waitFor(() => sock.of('request').length === 2, 'request');
    expect(lastRequest(sock).op).toMatchObject({
      op: 'start_space',
      goal: 'y',
      agent: 'claude',
      model: 'claude-opus-4-1',
      effort: 'xhigh',
    });
  });

  it("lists a host's agents, shape-checked, only when it takes spaces", async () => {
    const t = setup();
    await t.client.start();
    const agents = [
      {
        id: 'claude',
        label: 'Claude',
        default_model: 'opus',
        default_effort: 'high',
        models: [
          {
            id: 'opus',
            label: 'Opus',
            efforts: ['low', 'high', 'x'.repeat(17), 'high'],
            default_effort: 'nope',
          },
          { id: 'y'.repeat(65), label: 'Too long' },
          { id: 'sonnet', label: 'Sonnet <b>' + 'z'.repeat(80) },
        ],
      },
      { id: 'claude', label: 'Again' },
      { id: 42, label: 'Bad' },
      { id: 'codex', label: '' },
    ];
    await handshake(t.hub, [
      device(HOST, hostKey, { agents } as never),
      device(OTHER, strangerKey, {
        accepts_remote: false,
        agents,
      } as never),
    ]);
    await waitFor(() => state().devices.length === 2, 'devices');
    const host = state().devices.find((d) => d.deviceId === HOST)!;
    expect(host.agents).toEqual([
      {
        id: 'claude',
        label: 'Claude',
        defaultModel: 'opus',
        defaultEffort: 'high',
        models: [
          {
            id: 'opus',
            label: 'Opus',
            efforts: ['low', 'high'],
            defaultEffort: null,
          },
          {
            id: 'sonnet',
            label: ('Sonnet <b>' + 'z'.repeat(80)).slice(0, 64),
            efforts: [],
            defaultEffort: null,
          },
        ],
      },
      {
        id: 'codex',
        label: 'codex',
        defaultModel: null,
        defaultEffort: null,
        models: [],
      },
    ]);
    expect(state().devices.find((d) => d.deviceId === OTHER)!.agents).toEqual(
      [],
    );
  });

  it('ignores replies another key signed, or not the target, or unsigned', async () => {
    const { client, sock } = await connectedWithHost();
    const started = client.startSpace({
      deviceId: HOST,
      projectId: 'p1',
      goal: 'x',
      mode: 'ask',
    });
    await waitFor(() => sock.of('request').length === 1, 'request');
    const req = lastRequest(sock);
    const ok = {
      outcome: 'ok',
      value: { space: 's', name: 'forged', branch: 'b' },
    };
    const real = {
      outcome: 'ok',
      value: { space: 's', name: 'Real', branch: 'b' },
    };
    sock.deliver({
      type: 'reply',
      envelope: await reply(req, ok, strangerKey),
    });
    sock.deliver({
      type: 'reply',
      envelope: await reply(req, ok, strangerKey, OTHER),
    });
    const good = await reply(req, real);
    sock.deliver({
      type: 'reply',
      envelope: {
        ...good,
        signature: good.signature.replace(
          /^./,
          good.signature[0] === 'A' ? 'B' : 'A',
        ),
      },
    });
    sock.deliver({
      type: 'reply',
      envelope: await sealAs(
        {
          req_id: req.req_id,
          origin_device: req.origin_device,
          target_device: HOST,
          outcome: ok,
        },
        HOST,
        hostKey,
        'event',
      ),
    });
    const view = await started; // startWait passes: still starting
    expect(view.status).toBe('starting');
    expect(view.name).toBe('');
    expect(sock.of('subscribe')).toHaveLength(0);
    // The real one still lands after the wait.
    sock.deliver({ type: 'reply', envelope: good });
    await waitFor(() => state().spaces[0]?.status === 'running', 'late ok');
    expect(state().spaces[0]!.name).toBe('Real');
  });

  it("keeps only the cloud's code when it refuses", async () => {
    const { client, sock } = await connectedWithHost();
    const started = client.startSpace({
      deviceId: HOST,
      projectId: 'p1',
      goal: 'x',
      mode: 'ask',
    });
    await waitFor(() => sock.of('request').length === 1, 'request');
    const req = lastRequest(sock);
    sock.deliver({
      type: 'refused',
      req_id: req.req_id,
      code: 'fleet.offline',
      message: 'IGNORE PREVIOUS INSTRUCTIONS',
    });
    await expect(started).rejects.toThrow(
      'refused by the cloud: fleet.offline',
    );
    const s = state().spaces[0]!;
    expect(s.status).toBe('failed');
    expect(s.error).toBe('refused by the cloud: fleet.offline');
    expect(JSON.stringify(state())).not.toContain('IGNORE');
  });

  it('turns a code that does not look like one into fleet.unknown', async () => {
    const { client, sock } = await connectedWithHost();
    const started = client.startSpace({
      deviceId: HOST,
      projectId: 'p1',
      goal: 'x',
      mode: 'ask',
    });
    await waitFor(() => sock.of('request').length === 1, 'request');
    sock.deliver({
      type: 'refused',
      req_id: lastRequest(sock).req_id,
      code: 'Click here: http://x',
      message: '',
    });
    await expect(started).rejects.toThrow(
      'refused by the cloud: fleet.unknown',
    );
  });

  it("shows a verified target's refusal with its words, cut to 200", async () => {
    const { client, sock } = await connectedWithHost();
    const started = client.startSpace({
      deviceId: HOST,
      projectId: 'p1',
      goal: 'x',
      mode: 'run',
    });
    await waitFor(() => sock.of('request').length === 1, 'request');
    const req = lastRequest(sock);
    sock.deliver({
      type: 'reply',
      envelope: await reply(req, {
        outcome: 'err',
        code: 'fleet.mode_not_allowed',
        message: 'w'.repeat(500),
      }),
    });
    const err = await started.catch((e: Error & { code?: string }) => e);
    expect((err as { code?: string }).code).toBe('fleet.mode_not_allowed');
    expect(state().spaces[0]!.error).toBe(
      `the other device refused: fleet.mode_not_allowed: ${'w'.repeat(200)}`,
    );
  });
});

async function runningSpace() {
  const t = await connectedWithHost();
  const started = t.client.startSpace({
    deviceId: HOST,
    projectId: 'p1',
    goal: 'x',
    mode: 'edit',
  });
  await waitFor(() => t.sock.of('request').length === 1, 'request');
  const req = lastRequest(t.sock);
  t.sock.deliver({
    type: 'reply',
    envelope: await reply(req, {
      outcome: 'ok',
      value: { space: 'x', name: 'S', branch: 'b' },
    }),
  });
  const view = await started;
  return { ...t, space: view.space };
}

describe('events', () => {
  it('applies only events the host signed for its space', async () => {
    const { sock, space } = await runningSpace();
    const started = {
      kind: 'started',
      host_device: OTHER,
      origin_device: ME,
      project_id: 'p1',
      project_name: 'Theodore',
      name: 'Fix bug',
      branch: 'th/fix',
      mode: 'edit',
      depth: 0,
    };
    sock.deliver({
      type: 'space_event',
      envelope: await event(space, 1, started),
    });
    sock.deliver({
      type: 'space_event',
      envelope: await event(
        space,
        2,
        { kind: 'reply', turn: 1, text: 'forged' },
        strangerKey,
      ),
    });
    sock.deliver({
      type: 'space_event',
      envelope: await event(
        space,
        3,
        { kind: 'reply', turn: 1, text: 'wrong domain' },
        hostKey,
        'ask',
      ),
    });
    sock.deliver({
      type: 'space_event',
      envelope: await sealAs(
        {
          space,
          seq: 4,
          host_device: OTHER,
          event: { kind: 'reply', turn: 1, text: 'not the host' },
        },
        OTHER,
        strangerKey,
        'event',
      ),
    });
    sock.deliver({
      type: 'space_event',
      envelope: await event(space, 5, {
        kind: 'reply',
        turn: 1,
        text: 'done!',
      }),
    });
    sock.deliver({
      type: 'space_event',
      envelope: await event(space, 5, {
        kind: 'reply',
        turn: 1,
        text: 'replayed',
      }),
    });
    sock.deliver({
      type: 'space_event',
      envelope: await event(space, 6, { kind: 'status', status: 'idle' }),
    });
    await waitFor(() => state().spaces[0]?.status === 'idle', 'idle');
    const s = state().spaces[0]!;
    expect(s).toMatchObject({
      hostDevice: HOST,
      name: 'Fix bug',
      branch: 'th/fix',
      projectName: 'Theodore',
      lastReply: 'done!',
    });
    expect(state().lines[space]!.map((l) => [l.seq, l.kind, l.text])).toEqual([
      [1, 'started', 'Started Fix bug on th/fix (edit)'],
      [5, 'reply', 'done!'],
      [6, 'status', 'idle'],
    ]);
    expect(JSON.stringify(state())).not.toMatch(
      /forged|wrong domain|not the host|replayed/,
    );
  });

  it('drops events once the host is no longer trusted', async () => {
    const { client, sock, space } = await runningSpace();
    await client.untrust(HOST);
    sock.deliver({
      type: 'space_event',
      envelope: await event(space, 1, { kind: 'reply', turn: 1, text: 'hi' }),
    });
    await sleep(10);
    expect(state().lines[space] ?? []).toEqual([]);
  });

  it('shows a gap as a line and nothing else', async () => {
    const { client, sock, space } = await runningSpace();
    sock.deliver({ type: 'space_gap', space, from: 3, to: 9 });
    sock.deliver({ type: 'space_gap', space, from: 3, to: 9 });
    sock.deliver({ type: 'space_gap', space: 'rs_unknown', from: 1, to: 2 });
    await waitFor(() => (state().lines[space] ?? []).length === 1, 'gap');
    expect(await client.lines(space)).toEqual([
      { seq: 3, kind: 'gap', text: 'Events 3–9 are no longer available' },
    ]);
    expect(state().spaces[0]!.status).toBe('running');
  });

  it('shows a question from the event and the ask, answers it with a signed request', async () => {
    const { client, sock, space } = await runningSpace();
    sock.deliver({
      type: 'space_event',
      envelope: await event(space, 1, {
        kind: 'started',
        host_device: HOST,
        origin_device: ME,
        project_id: 'p1',
        project_name: 'T',
        name: 'Fix bug',
        branch: 'b',
        mode: 'edit',
        depth: 0,
      }),
    });
    const qs = [{ question: 'Which?', options: ['A', 'B'], multi: false }];
    sock.deliver({
      type: 'space_event',
      envelope: await event(space, 2, {
        kind: 'question',
        ask_id: 'ask_1',
        questions: qs,
      }),
    });
    const ask = await sealAs(
      {
        ask_id: 'ask_1',
        space,
        host_device: HOST,
        from: 'EVIL TEXT',
        questions: qs,
      },
      HOST,
      hostKey,
      'ask',
    );
    sock.deliver({ type: 'ask', envelope: ask, via: 'origin' });
    await waitFor(() => state().questions.length === 1, 'question');
    expect(state().questions[0]).toEqual({
      askId: 'ask_1',
      space,
      from: 'Mac bStudiob · Fix bug',
      questions: qs,
    });
    expect(state().spaces[0]!.question?.askId).toBe('ask_1');
    expect(JSON.stringify(state())).not.toContain('EVIL');

    const answered = client.answer(space, 'ask_1', [['A']]);
    await waitFor(() => sock.of('request').length === 2, 'answer request');
    const req = lastRequest(sock);
    expect(req.op).toEqual({
      op: 'answer',
      space,
      ask_id: 'ask_1',
      answers: [['A']],
    });
    sock.deliver({
      type: 'reply',
      envelope: await reply(req, { outcome: 'ok', value: null }),
    });
    await answered;
    expect(state().questions).toEqual([]);
  });

  it('drops asks that do not verify against the pin, and dismisses', async () => {
    const { sock, space } = await runningSpace();
    const body = {
      ask_id: 'ask_2',
      space,
      host_device: HOST,
      from: '',
      questions: [],
    };
    sock.deliver({
      type: 'ask',
      envelope: await sealAs(body, HOST, strangerKey, 'ask'),
      via: 'origin',
    });
    sock.deliver({
      type: 'ask',
      envelope: await sealAs(body, HOST, hostKey, 'event'),
      via: 'origin',
    });
    await sleep(10);
    expect(state().questions).toEqual([]);
    sock.deliver({
      type: 'ask',
      envelope: await sealAs(body, HOST, hostKey, 'ask'),
      via: 'origin',
    });
    await waitFor(() => state().questions.length === 1, 'ask');
    sock.deliver({
      type: 'dismiss',
      ask_id: 'ask_2',
      reason: 'answered_elsewhere',
    });
    await waitFor(() => state().questions.length === 0, 'dismissed');
  });
});

describe('mirrored rows', () => {
  const row = (space: string, over: object = {}) => ({
    id: space,
    name: 'fix-bug',
    goal: 'Fix the login bug',
    title: 'Login fix',
    branch: 'th/login',
    status: 'running',
    agent: 'claude',
    mode: 'plan',
    turns: 1,
    run: `space:${space}:m1`,
    created_at: 1,
    updated_at: 2,
    ...over,
  });
  const mirror = (model: string, id: string, data: unknown) => ({
    kind: 'mirror',
    model,
    id,
    data,
  });
  const chatRow = (space: string, over: object) => ({
    pr: `space:${space}`,
    author: { kind: 'me' },
    at: 1,
    ...over,
  });

  it('keeps only verified mirror rows, and the space row speaks for the list', async () => {
    const { sock, space } = await runningSpace();
    const run = `space:${space}:m1`;
    const send = async (seq: number, ev: object, key = hostKey) =>
      sock.deliver({
        type: 'space_event',
        envelope: await event(space, seq, ev, key),
      });
    await send(3, mirror('space', space, row(space)));
    await send(
      4,
      mirror(
        'chat_message',
        'm1',
        chatRow(space, { id: 'm1', text: 'forged' }),
      ),
      strangerKey,
    );
    await send(
      7,
      mirror(
        'chat_message',
        'm1',
        chatRow(space, { id: 'm1', text: 'Fix it' }),
      ),
    );
    await send(
      8,
      mirror('turn_step', `${run}:0`, { kind: 'text', text: 'Looking' }),
    );
    await waitFor(
      () => Object.keys(state().mirrors[space]?.steps ?? {}).length === 1,
      'step',
    );
    const m = state().mirrors[space]!;
    expect(m.space).toMatchObject({ id: space, title: 'Login fix' });
    expect(Object.values(m.messages).map((x) => x.text)).toEqual(['Fix it']);
    expect(state().spaces[0]).toMatchObject({
      name: 'Login fix',
      branch: 'th/login',
      mode: 'plan',
      status: 'running',
    });
    // Summary events still apply around them (holes in seq aren't gaps).
    await send(9, { kind: 'reply', turn: 1, text: 'sum' });
    await waitFor(() => state().spaces[0]?.lastReply === 'sum', 'reply line');
    expect(state().lines[space]!.map((l) => l.seq)).toEqual([9]);

    // The reply lands, then the row asks a question.
    await send(
      10,
      mirror(
        'chat_message',
        'm2',
        chatRow(space, {
          id: 'm2',
          author: { kind: 'agent', agent: 'claude' },
          text: 'The plan',
          at: 2,
          run,
        }),
      ),
    );
    const question = {
      id: 'ask_9',
      run,
      questions: [{ question: 'Which?', options: ['A', 'B'] }],
      asked_at: 3,
    };
    await send(11, mirror('space', space, row(space, { question })));
    await waitFor(() => state().spaces[0]?.status === 'waiting', 'waiting');
    expect(state().mirrors[space]!.steps).toEqual({});
    expect(state().spaces[0]!.lastReply).toBe('The plan');
    expect(state().spaces[0]!.question).toMatchObject({
      askId: 'ask_9',
      questions: [{ question: 'Which?', options: ['A', 'B'], multi: false }],
    });
    await send(
      12,
      mirror('space', space, row(space, { status: 'idle', run: null })),
    );
    await waitFor(() => state().spaces[0]?.status === 'idle', 'idle');
    expect(state().spaces[0]!.question).toBeNull();
    expect(JSON.stringify(state())).not.toContain('forged');
  });

  it('sends with the mode picked', async () => {
    const { client, sock, space } = await runningSpace();
    const sent = client.send(space, 'Plan approved, implement it.', 'edit');
    await waitFor(() => sock.of('request').length === 2, 'send');
    const req = lastRequest(sock);
    expect(req.op).toEqual({
      op: 'send',
      space,
      text: 'Plan approved, implement it.',
      mode: 'edit',
      agent: null,
      model: null,
      effort: null,
      attachments: [],
    });
    sock.deliver({
      type: 'reply',
      envelope: await reply(req, { outcome: 'ok', value: null }),
    });
    await sent;
  });
});

describe('steering', () => {
  it('sends, and puts the status back when the host refuses', async () => {
    const { client, sock, space } = await runningSpace();
    sock.deliver({
      type: 'space_event',
      envelope: await event(space, 1, { kind: 'status', status: 'idle' }),
    });
    await waitFor(() => state().spaces[0]?.status === 'idle', 'idle');
    const sent = client.send(space, 'go on');
    expect(state().spaces[0]!.status).toBe('running');
    await waitFor(() => sock.of('request').length === 2, 'send');
    const req = lastRequest(sock);
    expect(req.op).toEqual({
      op: 'send',
      space,
      text: 'go on',
      mode: null,
      agent: null,
      model: null,
      effort: null,
      attachments: [],
    });
    sock.deliver({
      type: 'reply',
      envelope: await reply(req, {
        outcome: 'err',
        code: 'fleet.busy',
        message: '',
      }),
    });
    await expect(sent).rejects.toThrow('the other device refused: fleet.busy');
    expect(state().spaces[0]!.status).toBe('idle');
  });

  it('a send while it runs is queued by the host: queued, its position', async () => {
    const { client, sock, space } = await runningSpace();
    const sent = client.send(space, 'and the tests');
    expect(state().spaces[0]!.status).toBe('running');
    await waitFor(() => sock.of('request').length === 2, 'send');
    sock.deliver({
      type: 'reply',
      envelope: await reply(lastRequest(sock), {
        outcome: 'ok',
        value: { message: 'm1', queued: true, position: 2 },
      }),
    });
    await expect(sent).resolves.toEqual({
      message: 'm1',
      queued: true,
      position: 2,
    });
    expect(state().spaces[0]!.status).toBe('running');
  });

  it('puts an agent, model or effort picked on the send, and only those', async () => {
    const { client, sock, space } = await runningSpace();
    const sent = client.send(space, 'go on', null, {
      agent: 'codex',
      effort: 'high',
    });
    await waitFor(() => sock.of('request').length === 2, 'send');
    const req = lastRequest(sock);
    expect(req.op).toEqual({
      op: 'send',
      space,
      text: 'go on',
      mode: null,
      agent: 'codex',
      model: null,
      effort: 'high',
      attachments: [],
    });
    sock.deliver({
      type: 'reply',
      envelope: await reply(req, { outcome: 'ok', value: null }),
    });
    await sent;
  });

  it('archives: the op signed to the host, the space hidden, Undo lists it again', async () => {
    const { client, sock, space } = await runningSpace();
    sock.deliver({
      type: 'space_event',
      envelope: await event(space, 1, { kind: 'status', status: 'idle' }),
    });
    await waitFor(() => state().spaces[0]?.status === 'idle', 'idle');
    const archived = client.archiveSpace(space);
    await waitFor(() => sock.of('request').length === 2, 'archive');
    const req = lastRequest(sock);
    expect(req.target_device).toBe(HOST);
    expect(req.op).toEqual({ op: 'archive_space', space });
    // Not before the host's word.
    expect(state().spaces.map((s) => s.space)).toEqual([space]);
    sock.deliver({
      type: 'reply',
      envelope: await reply(req, { outcome: 'ok', value: null }),
    });
    await archived;
    expect(state().spaces).toEqual([]);
    // Still tracked: its history stays, and it can come back.
    expect(state().lines[space]!.map((l) => l.seq)).toEqual([1]);

    const back = client.unarchiveSpace(space);
    await waitFor(() => sock.of('request').length === 3, 'unarchive');
    const again = lastRequest(sock);
    expect(again.op).toEqual({ op: 'unarchive_space', space });
    sock.deliver({
      type: 'reply',
      envelope: await reply(again, { outcome: 'ok', value: null }),
    });
    await back;
    expect(state().spaces.map((s) => s.space)).toEqual([space]);
  });

  it('a busy refusal of an archive keeps the space listed', async () => {
    const { client, sock, space } = await runningSpace();
    const archived = client.archiveSpace(space);
    await waitFor(() => sock.of('request').length === 2, 'archive');
    sock.deliver({
      type: 'reply',
      envelope: await reply(lastRequest(sock), {
        outcome: 'err',
        code: 'fleet.busy',
        message: 'stop it first',
      }),
    });
    await expect(archived).rejects.toThrow(
      'the other device refused: fleet.busy: stop it first',
    );
    expect(state().spaces.map((s) => s.space)).toEqual([space]);
  });

  it('a mirrored row saying archived hides the space; another status shows it', async () => {
    const { sock, space } = await runningSpace();
    const row = (status: string) => ({
      id: space,
      name: 'fix-bug',
      goal: 'Fix it',
      branch: 'th/fix',
      status,
      agent: 'claude',
      mode: 'edit',
      turns: 1,
      created_at: 1,
      updated_at: 2,
    });
    sock.deliver({
      type: 'space_event',
      envelope: await event(space, 1, {
        kind: 'mirror',
        model: 'space',
        id: space,
        data: row('archived'),
      }),
    });
    await waitFor(() => state().spaces.length === 0, 'hidden');
    sock.deliver({
      type: 'space_event',
      envelope: await event(space, 2, {
        kind: 'mirror',
        model: 'space',
        id: space,
        data: row('idle'),
      }),
    });
    await waitFor(() => state().spaces.length === 1, 'listed');
    expect(state().spaces[0]).toMatchObject({ space, status: 'idle' });
    expect(state().spaces[0]).not.toHaveProperty('archived');
  });

  it("times out when the host doesn't answer", async () => {
    const { client, space } = await runningSpace();
    await expect(client.stopSpace(space)).rejects.toThrow(/in time/);
  });

  it('refuses without a socket', async () => {
    const { client, sock, space } = await runningSpace();
    sock.drop(1006);
    await expect(client.stopSpace(space)).rejects.toThrow(/not connected/);
  });
});

describe('following (delegation)', () => {
  it('follows a space of an origin that delegated here when its ask verifies', async () => {
    const { client, hub } = setup();
    await client.start();
    const sock = await handshake(hub, [
      device(HOST, hostKey),
      device(OTHER, originKey),
    ]);
    await waitFor(() => state().devices.length === 2, 'devices');
    await client.trust(HOST, hostKey.publicKey);
    const deleg = (key = originKey, over = {}) =>
      sealAs(
        {
          origin_device: OTHER,
          delegate_device: ME,
          issued_at_ms: 1,
          expires_at_ms: 0,
          revoke: false,
          ...over,
        },
        OTHER,
        key,
        'delegate',
      );
    const ask = await sealAs(
      {
        ask_id: 'ask_9',
        space: 'rs_far',
        host_device: HOST,
        from: '',
        questions: [{ question: 'Q?', options: [], multi: false }],
      },
      HOST,
      hostKey,
      'ask',
    );

    // A forged or expired delegation follows nothing (the question still shows).
    sock.deliver({
      type: 'delegations',
      list: [
        await deleg(strangerKey),
        await deleg(originKey, { expires_at_ms: 5 }),
      ],
    });
    sock.deliver({ type: 'ask', envelope: ask, via: 'escalated' });
    await waitFor(() => state().questions.length === 1, 'question');
    expect(state().spaces).toEqual([]);
    sock.deliver({ type: 'dismiss', ask_id: 'ask_9', reason: 'resolved' });

    sock.deliver({ type: 'delegations', list: [await deleg()] });
    await sleep(10);
    sock.deliver({ type: 'ask', envelope: ask, via: 'origin' });
    await waitFor(() => state().spaces.length === 1, 'followed');
    expect(state().spaces[0]).toMatchObject({
      space: 'rs_far',
      hostDevice: HOST,
      startedHere: false,
      status: 'waiting',
    });
    expect(sock.of('subscribe')).toEqual([
      { type: 'subscribe', space: 'rs_far', since: 0 },
    ]);
    sock.deliver({
      type: 'space_event',
      envelope: await event('rs_far', 1, {
        kind: 'started',
        host_device: HOST,
        origin_device: OTHER,
        project_id: 'p',
        project_name: 'P',
        name: 'Far',
        branch: 'b',
        mode: 'plan',
        depth: 0,
      }),
    });
    await waitFor(() => state().spaces[0]?.name === 'Far', 'started');
    expect(state().spaces[0]).toMatchObject({
      originDevice: OTHER,
      mode: 'plan',
    });
  });
});

describe('kept across restarts', () => {
  const INDEX = 'theodore.fleet.spaces.user_1.org_test';
  const savedIds = async (hub: ReturnType<typeof fakePlatform>) => {
    const text = await hub.data.get(INDEX);
    return text ? (JSON.parse(text) as { spaces: string[] }).spaces : null;
  };
  /** Polls storage (async) until `pred` holds. */
  const until = async (pred: () => Promise<boolean>, what: string) => {
    const end = Date.now() + 1500;
    while (!(await pred())) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(2);
    }
  };
  /** A fresh process on the same device: same storage, empty memory. */
  const restart = (prev: ReturnType<typeof fakePlatform>) => {
    clients.forEach((c) => c.stop());
    useFleetState.setState(initialFleet, true);
    return setup({ platform: { storage: prev.storage, data: prev.data } });
  };
  const deleg = (over = {}) =>
    sealAs(
      {
        origin_device: OTHER,
        delegate_device: ME,
        issued_at_ms: 1,
        expires_at_ms: 0,
        revoke: false,
        ...over,
      },
      OTHER,
      originKey,
      'delegate',
    );

  it('lists a started space at once on launch and resubscribes from the last seq', async () => {
    const t = await runningSpace();
    const { sock, space } = t;
    for (const [seq, ev] of [
      [
        1,
        {
          kind: 'started',
          host_device: HOST,
          origin_device: ME,
          project_id: 'p1',
          project_name: 'Theodore',
          name: 'Fix bug',
          branch: 'th/fix',
          mode: 'edit',
          depth: 0,
        },
      ],
      [2, { kind: 'reply', turn: 1, text: 'done it' }],
      [5, { kind: 'status', status: 'idle' }],
    ] as const)
      sock.deliver({
        type: 'space_event',
        envelope: await event(space, seq, ev),
      });
    await waitFor(() => state().spaces[0]?.status === 'idle', 'idle');
    // Backgrounding saves at once (iOS may kill the app next).
    t.hub.setActive(false);
    await until(async () => (await savedIds(t.hub))?.[0] === space, 'saved');
    t.hub.setActive(true);

    const r = restart(t.hub);
    await r.client.start();
    // Shown before the socket says anything.
    expect(r.hub.sockets).toHaveLength(1);
    expect(r.hub.last().of('hello')).toHaveLength(0);
    expect(state().spaces).toHaveLength(1);
    expect(state().spaces[0]).toMatchObject({
      space,
      hostDevice: HOST,
      projectName: 'Theodore',
      name: 'Fix bug',
      branch: 'th/fix',
      status: 'idle',
      mode: 'edit',
      lastReply: 'done it',
      startedHere: true,
    });
    expect(state().lines[space]!.map((l) => l.seq)).toEqual([1, 2, 5]);

    const again = await handshake(r.hub, [device(HOST, hostKey)]);
    await waitFor(() => again.of('subscribe').length === 1, 'resubscribe');
    expect(again.of('subscribe')[0]).toEqual({
      type: 'subscribe',
      space,
      since: 5,
    });
    // What the cloud replays applies on top; older seqs are not applied twice.
    again.deliver({
      type: 'space_event',
      envelope: await event(space, 5, { kind: 'status', status: 'failed' }),
    });
    again.deliver({
      type: 'space_event',
      envelope: await event(space, 6, { kind: 'status', status: 'running' }),
    });
    await waitFor(() => state().spaces[0]?.status === 'running', 'replayed');
    expect(state().lines[space]!.map((l) => l.seq)).toEqual([1, 2, 5, 6]);
  });

  it('keeps the mirrored space row, chat and sub-spaces', async () => {
    const t = await runningSpace();
    const { sock, space } = t;
    const mirror = (seq: number, model: string, id: string, data: object) =>
      event(space, seq, { kind: 'mirror', model, id, data });
    sock.deliver({
      type: 'space_event',
      envelope: await mirror(3, 'space', space, {
        id: space,
        name: 'fix-bug',
        goal: 'Fix the login bug',
        title: 'Login fix',
        branch: 'th/login',
        status: 'idle',
        agent: 'claude',
        mode: 'plan',
        turns: 1,
        created_at: 1,
        updated_at: 2,
      }),
    });
    sock.deliver({
      type: 'space_event',
      envelope: await mirror(4, 'chat_message', 'm1', {
        id: 'm1',
        pr: `space:${space}`,
        author: { kind: 'agent', agent: 'claude' },
        text: 'The plan',
        at: 2,
      }),
    });
    const child = {
      space: 'a1b2c3d4e5f6',
      parent: space,
      title: 'Split the crate',
      status: 'running',
      mode: 'edit',
      done: false,
    };
    sock.deliver({
      type: 'space_event',
      envelope: await mirror(5, 'sub_space', child.space, child),
    });
    await waitFor(() => state().spaces[0]?.lastReply === 'The plan', 'mirror');
    // Live: in the store as it arrives.
    await waitFor(
      () => !!state().mirrors[space]?.subSpaces[child.space],
      'sub-space',
    );
    t.hub.setActive(false);
    await until(
      async () =>
        (
          await t.hub.data.get(`${INDEX.replace('spaces', 'space')}.${space}`)
        )?.includes('The plan') ?? false,
      'saved',
    );

    const r = restart(t.hub);
    await r.client.start();
    expect(state().spaces[0]).toMatchObject({
      name: 'Login fix',
      mode: 'plan',
      status: 'idle',
    });
    const m = state().mirrors[space]!;
    expect(m.space).toMatchObject({ id: space, title: 'Login fix' });
    expect(Object.values(m.messages).map((x) => x.text)).toEqual(['The plan']);
    expect(m.subSpaces).toEqual({ [child.space]: child });
    const again = await handshake(r.hub, [device(HOST, hostKey)]);
    await waitFor(() => again.of('subscribe').length === 1, 'resubscribe');
    expect(again.of('subscribe')[0]!.since).toBe(5);
  });

  it('brings a followed space back only while its origin still delegates here', async () => {
    const { client, hub } = setup();
    await client.start();
    const sock = await handshake(hub, [
      device(HOST, hostKey),
      device(OTHER, originKey),
    ]);
    await waitFor(() => state().devices.length === 2, 'devices');
    await client.trust(HOST, hostKey.publicKey);
    sock.deliver({ type: 'delegations', list: [await deleg()] });
    await sleep(10);
    sock.deliver({
      type: 'space_event',
      envelope: await event('rs_far', 1, {
        kind: 'status',
        status: 'running',
      }),
    });
    await waitFor(() => state().spaces.length === 1, 'followed');
    sock.deliver({
      type: 'space_event',
      envelope: await event('rs_far', 1, {
        kind: 'started',
        host_device: HOST,
        origin_device: OTHER,
        project_id: 'p',
        project_name: 'P',
        name: 'Far',
        branch: 'b',
        mode: 'plan',
        depth: 0,
      }),
    });
    await waitFor(() => state().spaces[0]?.name === 'Far', 'started');
    hub.setActive(false);
    await until(async () => (await savedIds(hub))?.[0] === 'rs_far', 'saved');

    // Still delegated: listed at once, subscribed from its seq after the check.
    const r = restart(hub);
    await r.client.start();
    expect(state().spaces[0]).toMatchObject({
      space: 'rs_far',
      name: 'Far',
      startedHere: false,
      originDevice: OTHER,
    });
    const s2 = await handshake(r.hub, [
      device(HOST, hostKey),
      device(OTHER, originKey),
    ]);
    await sleep(10);
    expect(s2.of('subscribe')).toEqual([]);
    s2.deliver({ type: 'delegations', list: [await deleg()] });
    await waitFor(() => s2.of('subscribe').length === 1, 'resubscribe');
    expect(s2.of('subscribe')[0]).toEqual({
      type: 'subscribe',
      space: 'rs_far',
      since: 1,
    });

    // Revoked meanwhile: gone from the list and from storage.
    const r3 = restart(r.hub);
    await r3.client.start();
    expect(state().spaces).toHaveLength(1);
    const s3 = await handshake(r3.hub, [
      device(HOST, hostKey),
      device(OTHER, originKey),
    ]);
    s3.deliver({ type: 'delegations', list: [await deleg({ revoke: true })] });
    await waitFor(() => state().spaces.length === 0, 'dropped');
    expect(state().lines['rs_far']).toBeUndefined();
    expect(s3.of('subscribe')).toEqual([]);
    r3.hub.setActive(false);
    await until(async () => (await savedIds(r3.hub))?.length === 0, 'unsaved');
  });

  it('clears what it kept on sign-out', async () => {
    const t = await runningSpace();
    t.hub.setActive(false);
    await until(async () => (await savedIds(t.hub))?.length === 1, 'saved');
    t.account.emit(null);
    await until(async () => (await savedIds(t.hub)) === null, 'cleared');
    expect(
      await t.hub.data.get(`theodore.fleet.space.user_1.org_test.${t.space}`),
    ).toBeNull();
    const r = restart(t.hub);
    await r.client.start();
    expect(state().spaces).toEqual([]);
  });

  it('keeps an org’s spaces across a switch away and back', async () => {
    const t = await runningSpace();
    t.hub.setActive(false);
    await until(async () => (await savedIds(t.hub))?.length === 1, 'saved');
    t.hub.setActive(true);
    t.account.emit(session('tok-1', 'org_other'));
    await waitFor(() => state().spaces.length === 0, 'the other org shown');
    expect(await savedIds(t.hub)).toHaveLength(1);
    t.account.emit(session('tok-1', 'org_test'));
    await waitFor(() => state().spaces.length === 1, 'listed again');
  });

  it('drops a set written for another device id', async () => {
    const t = await runningSpace();
    t.hub.setActive(false);
    await until(async () => (await savedIds(t.hub))?.length === 1, 'saved');
    // A backup restored on a new phone: no device id of this org here.
    await t.hub.storage.remove('theodore.fleet.device_id.org_test');
    const r = restart(t.hub);
    await r.client.start();
    expect(state().spaces).toEqual([]);
    expect(await savedIds(r.hub)).toBeNull();
  });
});

describe('answer over HTTP', () => {
  it('posts a signed answer with the bearer token', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const { client, hub } = setup({ fetch: fetchFn });
    await hub.storage.set('theodore.fleet.device_id.org_test', ME);
    await expect(
      client.answerOverHttp('rs_1', 'ask_1', [['A']], HOST),
    ).rejects.toThrow(/isn't trusted/);
    await client.start();
    await handshake(hub, [device(HOST, hostKey)]);
    await waitFor(() => state().devices.length === 1, 'devices');
    await client.trust(HOST, hostKey.publicKey);
    client.stop();

    await client.answerOverHttp('rs_1', 'ask_1', [['A']], HOST);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://cloud.test/v1/fleet/request');
    expect(
      (calls[0]!.init.headers as Record<string, string>).authorization,
    ).toBe('Bearer tok-1');
    const sent = JSON.parse(calls[0]!.init.body as string) as {
      device_id: string;
      envelope: SignedEnvelope;
    };
    expect(sent.device_id).toBe(ME);
    const req = open(sent.envelope, myKey.publicKey, 'request')!;
    expect(req).toMatchObject({
      origin_device: ME,
      target_device: HOST,
      target_key: hostKey.publicKey,
      op: { op: 'answer', space: 'rs_1', ask_id: 'ask_1', answers: [['A']] },
    });
  });

  it('answers as another signed-in account with its token and that org’s device id', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const { client, hub } = setup({ fetch: fetchFn });
    const OTHER_ME = 'dev_00000000-0000-4000-8000-0000000000e5';
    await hub.storage.set('theodore.fleet.device_id.org_work', OTHER_ME);
    await client.start();
    await handshake(hub, [device(HOST, hostKey)]);
    await waitFor(() => state().devices.length === 1, 'devices');
    await client.trust(HOST, hostKey.publicKey);
    await client.answerOverHttp('rs_9', 'ask_9', [['B']], HOST, {
      accessToken: 'tok-work',
      organizationId: 'org_work',
    });
    expect(
      (calls[0]!.init.headers as Record<string, string>).authorization,
    ).toBe('Bearer tok-work');
    const sent = JSON.parse(calls[0]!.init.body as string) as {
      device_id: string;
      envelope: SignedEnvelope;
    };
    expect(sent.device_id).toBe(OTHER_ME);
    expect(open(sent.envelope, myKey.publicKey, 'request')).toMatchObject({
      origin_device: OTHER_ME,
      op: { op: 'answer', space: 'rs_9' },
    });
  });

  it('throws the refusal code only', async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({ error: { code: 'fleet.offline', message: 'EVIL' } }),
        { status: 409 },
      )) as unknown as typeof fetch;
    const { client, hub } = setup({ fetch: fetchFn });
    await client.start();
    await handshake(hub, [device(HOST, hostKey)]);
    await waitFor(() => state().devices.length === 1, 'devices');
    await client.trust(HOST, hostKey.publicKey);
    const err = (await client
      .answerOverHttp('rs_1', 'a', [['x']], HOST)
      .catch((e: Error) => e)) as Error;
    expect(err.message).toBe('refused by the cloud: fleet.offline');
  });
});

const MCP = 'dev_00000000-0000-4000-8000-0000000000d4';

const confirmBody = (over: object = {}) => ({
  confirm_id: 'req_c1',
  host_device: HOST,
  mcp_device: MCP,
  action: 'start',
  mode: 'edit',
  project_name: 'theodore',
  space_name: null,
  text: 'Fix the login test',
  expires_at_ms: Date.now() + 60_000,
  ...over,
});

describe('confirms (Claude via cloud)', () => {
  it('keeps a confirm only when it verifies against the host pin', async () => {
    const { sock } = await connectedWithHost();
    const body = confirmBody();
    // Bad signature, wrong domain, signer not the host, expired.
    sock.deliver({
      type: 'confirm',
      envelope: await sealAs(body, HOST, strangerKey, 'confirm'),
    });
    sock.deliver({
      type: 'confirm',
      envelope: await sealAs(body, HOST, hostKey, 'ask'),
    });
    sock.deliver({
      type: 'confirm',
      envelope: await sealAs(
        confirmBody({ host_device: OTHER }),
        HOST,
        hostKey,
        'confirm',
      ),
    });
    sock.deliver({
      type: 'confirm',
      envelope: await sealAs(
        confirmBody({ expires_at_ms: Date.now() - 1 }),
        HOST,
        hostKey,
        'confirm',
      ),
    });
    // A type this build doesn't know: ignored.
    sock.deliver({ type: 'something_new', x: 1 });
    await sleep(10);
    expect(state().confirms).toEqual([]);

    sock.deliver({
      type: 'confirm',
      envelope: await sealAs(body, HOST, hostKey, 'confirm'),
    });
    await waitFor(() => state().confirms.length === 1, 'confirm');
    expect(state().confirms[0]).toEqual({
      confirmId: 'req_c1',
      hostDevice: HOST,
      hostName: 'Mac bStudiob',
      mcpDevice: MCP,
      action: 'start',
      mode: 'edit',
      projectName: 'theodore',
      spaceName: '',
      text: 'Fix the login test',
      expiresAtMs: body.expires_at_ms,
    });
    sock.deliver({ type: 'confirm_dismissed', confirm_id: 'req_c1' });
    await waitFor(() => state().confirms.length === 0, 'dismissed');
  });

  it('drops a confirm from a host that is not trusted here', async () => {
    const t = setup();
    await t.client.start();
    const sock = await handshake(t.hub, [device(HOST, hostKey)]);
    await waitFor(() => state().devices.length === 1, 'devices');
    sock.deliver({
      type: 'confirm',
      envelope: await sealAs(confirmBody(), HOST, hostKey, 'confirm'),
    });
    await sleep(10);
    expect(state().confirms).toEqual([]);
  });

  it('drops a confirm once it expires', async () => {
    const { sock } = await connectedWithHost();
    sock.deliver({
      type: 'confirm',
      envelope: await sealAs(
        confirmBody({ expires_at_ms: Date.now() + 40 }),
        HOST,
        hostKey,
        'confirm',
      ),
    });
    await waitFor(() => state().confirms.length === 1, 'confirm');
    await waitFor(() => state().confirms.length === 0, 'expired');
  });

  it('answers with a signed confirm request; a late one goes quietly', async () => {
    const { client, sock } = await connectedWithHost();
    sock.deliver({
      type: 'confirm',
      envelope: await sealAs(confirmBody(), HOST, hostKey, 'confirm'),
    });
    await waitFor(() => state().confirms.length === 1, 'confirm');
    const sent = client.confirm(HOST, 'req_c1', true);
    await waitFor(() => sock.of('request').length === 1, 'request');
    const req = lastRequest(sock);
    expect(req).toMatchObject({
      origin_device: ME,
      target_device: HOST,
      target_key: hostKey.publicKey,
      op: { op: 'confirm', confirm_id: 'req_c1', allow: true },
    });
    expect(sock.of('request')[0]!.envelope.body).toContain(
      '"op":{"op":"confirm","confirm_id":"req_c1","allow":true}',
    );
    // Sent: the card is gone already.
    expect(state().confirms).toEqual([]);
    sock.deliver({
      type: 'reply',
      envelope: await reply(req, {
        outcome: 'err',
        code: 'fleet.invalid',
        message: 'already answered',
      }),
    });
    await sent;

    const denied = client.confirm(HOST, 'req_c2', false);
    await waitFor(() => sock.of('request').length === 2, 'second');
    const req2 = lastRequest(sock);
    expect(req2.op).toEqual({
      op: 'confirm',
      confirm_id: 'req_c2',
      allow: false,
    });
    sock.deliver({
      type: 'reply',
      envelope: await reply(req2, {
        outcome: 'err',
        code: 'fleet.offline',
        message: '',
      }),
    });
    await expect(denied).rejects.toThrow('fleet.offline');
  });

  it('a new welcome clears confirms (the cloud sends the waiting ones again)', async () => {
    const { sock, hub } = await connectedWithHost();
    sock.deliver({
      type: 'confirm',
      envelope: await sealAs(confirmBody(), HOST, hostKey, 'confirm'),
    });
    await waitFor(() => state().confirms.length === 1, 'confirm');
    sock.drop(1006);
    await handshake(hub, [device(HOST, hostKey)], 2);
    await waitFor(() => state().confirms.length === 0, 'cleared');
  });

  it('confirms over HTTP with a signed request', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const { client, hub } = setup({ fetch: fetchFn });
    await client.start();
    const sock = await handshake(hub, [device(HOST, hostKey)]);
    await waitFor(() => state().devices.length === 1, 'devices');
    await client.trust(HOST, hostKey.publicKey);
    sock.deliver({
      type: 'confirm',
      envelope: await sealAs(confirmBody(), HOST, hostKey, 'confirm'),
    });
    await waitFor(() => state().confirms.length === 1, 'confirm');

    await client.confirmOverHttp(HOST, 'req_c1', false);
    expect(calls[0]!.url).toBe('https://cloud.test/v1/fleet/request');
    const sent = JSON.parse(calls[0]!.init.body as string) as {
      envelope: SignedEnvelope;
    };
    expect(open(sent.envelope, myKey.publicKey, 'request')).toMatchObject({
      origin_device: ME,
      target_device: HOST,
      target_key: hostKey.publicKey,
      op: { op: 'confirm', confirm_id: 'req_c1', allow: false },
    });
    expect(state().confirms).toEqual([]);
  });
});

describe('auto mode (Claude via cloud)', () => {
  it("lists a computer's mcp_auto, shape-checked, named from the listing", async () => {
    const t = setup();
    await t.client.start();
    const later = Date.now() + 3_600_000;
    await handshake(t.hub, [
      device(HOST, hostKey, {
        mcp_auto: [
          { device_id: MCP, auto: 'edit', until_ms: later },
          { device_id: OTHER, auto: 'full', until_ms: Date.now() - 1 },
          { device_id: 'dev_bad', auto: 'full', until_ms: null },
          { device_id: MCP, auto: 'full', until_ms: null },
          // @ts-expect-error: an auto this build doesn't know
          { device_id: OTHER, auto: 'all', until_ms: null },
        ],
      }),
      device(MCP, strangerKey, {
        kind: 'mcp',
        name: 'Claude (cloud)',
        accepts_remote: false,
        mcp_auto: [{ device_id: OTHER, auto: 'full', until_ms: null }],
      }),
    ]);
    await waitFor(() => state().devices.length === 2, 'devices');
    const host = state().devices.find((d) => d.deviceId === HOST)!;
    expect(host.mcpAuto).toEqual([
      { deviceId: MCP, name: 'Claude (cloud)', auto: 'edit', untilMs: later },
      { deviceId: OTHER, name: 'Claude via cloud', auto: 'off', untilMs: null },
    ]);
    // Never on a non-computer.
    expect(state().devices.find((d) => d.deviceId === MCP)!.mcpAuto).toEqual(
      [],
    );
  });

  it('sets it with a signed set_mcp_auto request to the computer', async () => {
    const { client, sock } = await connectedWithHost();
    const until = Date.now() + 3_600_000;
    const done = client.setMcpAuto(HOST, MCP, 'full', until);
    await waitFor(() => sock.of('request').length === 1, 'request');
    const req = lastRequest(sock);
    expect(req.target_device).toBe(HOST);
    expect(req.op).toEqual({
      op: 'set_mcp_auto',
      mcp_device: MCP,
      auto: 'full',
      until_ms: until,
    });
    sock.deliver({
      type: 'reply',
      envelope: await reply(req, { outcome: 'ok', value: null }),
    });
    await done;

    // Off never carries an end.
    const off = client.setMcpAuto(HOST, MCP, 'off', until);
    await waitFor(() => sock.of('request').length === 2, 'off');
    const req2 = lastRequest(sock);
    expect(sock.of('request')[1]!.envelope.body).toContain(
      `"op":{"op":"set_mcp_auto","mcp_device":"${MCP}","auto":"off","until_ms":null}`,
    );
    sock.deliver({
      type: 'reply',
      envelope: await reply(req2, { outcome: 'ok', value: null }),
    });
    await off;
  });

  it('refuses a computer that is not trusted here', async () => {
    const t = setup();
    await t.client.start();
    await handshake(t.hub, [device(HOST, hostKey)]);
    await waitFor(() => state().devices.length === 1, 'devices');
    await expect(t.client.setMcpAuto(HOST, MCP, 'edit', null)).rejects.toThrow(
      /isn't trusted/,
    );
  });
});

describe('any space on a host (sub-spaces)', () => {
  const CHILD = 'a1b2c3d4e5f6';
  const readValue = {
    note: 'data',
    space: {
      space: CHILD,
      name: 'flaky',
      title: 'Fix the flaky test',
      status: 'running',
      mode: 'edit',
      agent: 'claude',
      turns: 2,
      done: false,
    },
    goal: 'Fix it',
    branch: 'agent/flaky',
    messages: [{ from: 'user', at: 1, text: 'hi', truncated: false }],
    live: 'Editing…',
  };

  it('reads a space by its local id with a signed read_space, shape-checked', async () => {
    const { client, sock } = await connectedWithHost();
    const read = client.readSpace(HOST, CHILD);
    await waitFor(() => sock.of('request').length === 1, 'request');
    const req = lastRequest(sock);
    expect(req.target_device).toBe(HOST);
    expect(req.target_key).toBe(hostKey.publicKey);
    expect(req.op).toEqual({ op: 'read_space', space: CHILD, messages: 50 });
    sock.deliver({
      type: 'reply',
      envelope: await reply(req, {
        outcome: 'ok',
        value: { ...readValue, extra: 'dropped' },
      }),
    });
    const r = await read;
    expect(r.space).toBe(CHILD);
    expect(r.title).toBe('Fix the flaky test');
    expect(r.status).toBe('running');
    expect(r.messages).toEqual([
      { from: 'user', at: 1, text: 'hi', truncated: false },
    ]);
    expect(r.live).toBe('Editing…');
    expect(r.question).toBeNull();
    expect('extra' in r).toBe(false);
  });

  it('caps the messages asked for at 50, at least 1', async () => {
    const { client, sock } = await connectedWithHost();
    void client.readSpace(HOST, CHILD, 500).catch(() => {});
    void client.readSpace(HOST, CHILD, 0).catch(() => {});
    await waitFor(() => sock.of('request').length === 2, 'requests');
    const ops = sock
      .of('request')
      .map((r) => open(r.envelope, myKey.publicKey, 'request')!.op);
    expect(ops).toEqual([
      { op: 'read_space', space: CHILD, messages: 50 },
      { op: 'read_space', space: CHILD, messages: 1 },
    ]);
  });

  it('refuses an answer about another space, a refusal, silence, a bad id', async () => {
    const { client, sock } = await connectedWithHost();
    const wrong = client.readSpace(HOST, CHILD);
    await waitFor(() => sock.of('request').length === 1, 'request');
    sock.deliver({
      type: 'reply',
      envelope: await reply(lastRequest(sock), {
        outcome: 'ok',
        value: { ...readValue, space: { ...readValue.space, space: 'other' } },
      }),
    });
    await expect(wrong).rejects.toThrow(/wasn't about that space/);

    const refused = client.readSpace(HOST, CHILD);
    await waitFor(() => sock.of('request').length === 2, 'request');
    sock.deliver({
      type: 'reply',
      envelope: await reply(lastRequest(sock), {
        outcome: 'err',
        code: 'fleet.unknown_space',
        message: 'gone',
      }),
    });
    await expect(refused).rejects.toThrow(
      'the other device refused: fleet.unknown_space: gone',
    );

    // A reply signed by someone else than the host is not an answer.
    const forged = client.readSpace(HOST, CHILD);
    await waitFor(() => sock.of('request').length === 3, 'request');
    sock.deliver({
      type: 'reply',
      envelope: await reply(
        lastRequest(sock),
        { outcome: 'ok', value: readValue },
        strangerKey,
      ),
    });
    await expect(forged).rejects.toThrow(/in time/);

    await expect(client.readSpace(HOST, 'not a space id')).rejects.toThrow(
      /not a space id/,
    );
    expect(sock.of('request')).toHaveLength(3);
    await expect(client.readSpace(OTHER, CHILD)).rejects.toThrow(
      /isn't trusted/,
    );
  });

  it('acts on a queued message with queued_message: Send now, Remove', async () => {
    const { client, sock } = await connectedWithHost();
    const sending = client.queuedMessage(HOST, CHILD, 'm9', 'send');
    await waitFor(() => sock.of('request').length === 1, 'request');
    const req = lastRequest(sock);
    expect(req.op).toEqual({
      op: 'queued_message',
      space: CHILD,
      message: 'm9',
      action: 'send',
    });
    sock.deliver({
      type: 'reply',
      envelope: await reply(req, { outcome: 'ok', value: {} }),
    });
    await expect(sending).resolves.toBeUndefined();

    // Gone from the queue meanwhile: the host's refusal, by its code.
    const removing = client.queuedMessage(HOST, CHILD, 'm9', 'cancel');
    await waitFor(() => sock.of('request').length === 2, 'request');
    expect(lastRequest(sock).op).toMatchObject({
      op: 'queued_message',
      action: 'cancel',
    });
    sock.deliver({
      type: 'reply',
      envelope: await reply(lastRequest(sock), {
        outcome: 'err',
        code: 'fleet.unknown_space',
        message: 'not queued any more',
      }),
    });
    await expect(removing).rejects.toMatchObject({
      code: 'fleet.unknown_space',
    });
    // Not a message id: nothing goes on the wire.
    await expect(
      client.queuedMessage(HOST, CHILD, 'm 9', 'send'),
    ).rejects.toThrow(/message id/);
    expect(sock.of('request').length).toBe(2);
  });

  it('sends to it with send_to (its own mode, no agent), queued or not', async () => {
    const { client, sock } = await connectedWithHost();
    const sent = client.sendTo(HOST, CHILD, '  go on  ');
    await waitFor(() => sock.of('request').length === 1, 'request');
    const req = lastRequest(sock);
    expect(req.op).toEqual({
      op: 'send_to',
      space: CHILD,
      message: 'go on',
      attachments: [],
    });
    sock.deliver({
      type: 'reply',
      envelope: await reply(req, {
        outcome: 'ok',
        value: { message: 'm9', queued: true, position: 1 },
      }),
    });
    await expect(sent).resolves.toEqual({
      message: 'm9',
      queued: true,
      position: 1,
    });

    const now = client.sendTo(HOST, CHILD, 'again');
    await waitFor(() => sock.of('request').length === 2, 'request');
    sock.deliver({
      type: 'reply',
      envelope: await reply(lastRequest(sock), {
        outcome: 'ok',
        value: { message: 'm10' },
      }),
    });
    await expect(now).resolves.toEqual({
      message: 'm10',
      queued: false,
      position: null,
    });

    await expect(client.sendTo(HOST, CHILD, '   ')).rejects.toThrow(/empty/);
    const busy = client.sendTo(HOST, CHILD, 'x');
    await waitFor(() => sock.of('request').length === 3, 'request');
    sock.deliver({
      type: 'reply',
      envelope: await reply(lastRequest(sock), {
        outcome: 'err',
        code: 'fleet.busy',
        message: '',
      }),
    });
    await expect(busy).rejects.toThrow('the other device refused: fleet.busy');
  });

  it('answers its question with answer_space', async () => {
    const { client, sock } = await connectedWithHost();
    const done = client.answerSpace(HOST, CHILD, 'ask-1', [['a'], ['b', 'c']]);
    await waitFor(() => sock.of('request').length === 1, 'request');
    const req = lastRequest(sock);
    expect(req.op).toEqual({
      op: 'answer_space',
      space: CHILD,
      ask: 'ask-1',
      answers: [['a'], ['b', 'c']],
    });
    sock.deliver({
      type: 'reply',
      envelope: await reply(req, { outcome: 'ok', value: {} }),
    });
    await done;

    const late = client.answerSpace(HOST, CHILD, 'ask-1', [['a']]);
    await waitFor(() => sock.of('request').length === 2, 'request');
    sock.deliver({
      type: 'reply',
      envelope: await reply(lastRequest(sock), {
        outcome: 'err',
        code: 'fleet.invalid',
        message: '',
      }),
    });
    await expect(late).rejects.toThrow('fleet.invalid');
  });
});

describe('keys', () => {
  it('makes a seed key once, keeps it, and refuses to replace an unreadable one', async () => {
    const storage = memoryStorage();
    let made = 0;
    const store = seedKeyStore(storage, (n) => {
      made++;
      return new Uint8Array(n).fill(7);
    });
    const [a, b] = await Promise.all([store.deviceKey(), store.deviceKey()]);
    expect(a.publicKey).toBe(b.publicKey);
    expect(made).toBe(1);
    const again = seedKeyStore(storage, () => new Uint8Array(32));
    expect((await again.deviceKey()).publicKey).toBe(a.publicKey);
    const sig = await a.sign(utf8('m'));
    expect(verifySignature(a.publicKey, utf8('m'), sig)).toBe(true);

    await storage.set('theodore.fleet.device_key', 'junk');
    await expect(
      seedKeyStore(storage, () => new Uint8Array(32)).deviceKey(),
    ).rejects.toThrow(/unreadable/);
    await again.forget();
    expect(await storage.get('theodore.fleet.device_key')).toBeNull();
  });
});
