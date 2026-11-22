// What the fleet hub logs (docs/telemetry.md "Cloud"): connections, requests,
// pushes, limits, each as ids and kinds, never a token, a nonce or a body.
import { describe, expect, it } from 'vitest';
import { Logger, type LogRecord } from '../src/telemetry/log';
import { hashText } from '../src/telemetry/redact';
import { Harness, startSpace } from './fleet-harness';

function harness() {
  const local: LogRecord[] = [];
  const remote: LogRecord[] = [];
  const log = new Logger({
    local: (r) => local.push(r),
    remote: (r) => remote.push(r),
  });
  const h = new Harness(undefined, { log });
  const of = (msg: string) => local.filter((r) => r.msg === msg);
  return { h, local, remote, of };
}

describe('hub logs', () => {
  it('a connect and a disconnect, with kinds and codes', async () => {
    const { h, remote, of } = harness();
    const mac = await h.device('user_1', 'mac');
    await mac.connect();
    const connected = of('fleet connected')[0]!;
    expect(connected.attrs).toMatchObject({
      user_id: 'user_1',
      org_id: 'org_1',
      device_id: mac.id,
      device_kind: 'desktop',
      protocol: 7,
      os: 'macos',
      new_device: true,
    });
    expect('name' in connected.attrs).toBe(false);
    await mac.disconnect();
    const gone = of('fleet disconnected')[0]!;
    expect(gone.attrs).toMatchObject({
      by: 'device',
      device_id: mac.id,
      device_kind: 'desktop',
    });
    // Remote copies carry hashed identities.
    const r = remote.find((x) => x.msg === 'fleet connected')!;
    expect(r.attrs.user_id).toBe(`h:${hashText('user_1')}`);
    expect(r.attrs.device_id).toBe(mac.id);
  });

  it('a refusal by the cloud names the code and the close code', async () => {
    const { h, of } = harness();
    const mac = await h.device('user_1', 'mac');
    const { nonce } = await mac.open();
    await mac.send({
      type: 'hello',
      protocol: 7,
      device_id: null,
      public_key: mac.publicKey,
      signature: await mac.signHello(nonce.slice(0, 10) + 'AAAA'),
      info: {
        name: 'x',
        os: 'macos',
        kind: 'desktop',
        app_version: '1',
        projects: [],
        accepts_remote: true,
        max_mode: 'edit',
        agents: [],
        mcp_auto: [],
      },
      spaces: [],
    });
    const gone = of('fleet disconnected')[0]!;
    expect(gone.attrs).toMatchObject({
      by: 'cloud',
      code: 'fleet.bad_signature',
      close_code: 1008,
      phase: 'challenged',
    });
  });

  it('requests: op, outcome, code and latency; quota hits', async () => {
    const { h, of } = harness();
    const mac = await h.device('user_1', 'mac');
    await mac.connect();
    const phone = await h.phone('user_1');
    await phone.connect();
    await phone.request(mac.id!, { op: 'stop', space: 'rs_none' });
    const line = of('fleet request')[0]!;
    expect(line.attrs).toMatchObject({
      user_id: 'user_1',
      via: 'ws',
      origin_kind: 'mobile',
    });
    expect(typeof line.attrs.op).toBe('string');
    expect(typeof line.attrs.ms).toBe('number');
    expect(['routed', 'refused', 'error']).toContain(line.attrs.outcome);
  });

  it('never logs a token, a nonce, a public key or a goal', async () => {
    const { h, local, remote } = harness();
    const mac = await h.device('user_1', 'mac');
    await mac.connect();
    h.tokens.set('secret-token', { userId: 'user_1', organizationId: 'org_1' });
    await mac.send({ type: 'reauth', access_token: 'secret-token' });
    await mac.send({ type: 'reauth', access_token: 'bad-token' });
    const text = JSON.stringify([...local, ...remote]);
    expect(text).not.toContain('secret-token');
    expect(text).not.toContain('bad-token');
    expect(text).not.toContain(mac.publicKey);
  });

  it('a rate-limit hit is one line', async () => {
    const { h, of } = harness();
    const mac = await h.device('user_1', 'mac');
    await mac.connect();
    const presence = {
      type: 'presence',
      focused: false,
      locked: false,
      idle_ms: 0,
    } as const;
    for (let i = 0; i < 560; i++) await mac.send(presence);
    const lines = of('rate limited');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.attrs).toMatchObject({
      bucket: 'fleet',
      device_id: mac.id,
    });
  });

  it('a push send is summarized by outcome', async () => {
    const { h, of } = harness();
    const mac = await h.device('user_1', 'mac');
    await mac.connect();
    const phone = await h.phone('user_1');
    await phone.connect();
    await phone.send({
      type: 'register_push',
      provider: 'expo',
      token: 'ExponentPushToken[abc]',
    });
    const space = 'rs_1';
    await startSpace(phone, mac, space);
    await phone.disconnect();
    await mac.emit(space, 1, { kind: 'status', status: 'running' });
    await mac.emit(space, 2, { kind: 'status', status: 'idle' });
    await h.settle();
    const line = of('push sent')[0];
    expect(line?.attrs).toMatchObject({
      provider: 'expo',
      kind: 'finished',
      sent: 1,
      ok: 1,
    });
    expect(JSON.stringify(line)).not.toContain('ExponentPushToken');
    expect(JSON.stringify(line)).not.toContain('Space');
  });
});
