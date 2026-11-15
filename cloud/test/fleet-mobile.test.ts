// Protocol 4: phones and browsers as fleet clients (docs/mobile.md): old
// protocol connections, targets, push tokens and pushes, delegations, and
// the one-shot HTTP request.
import { describe, expect, it } from 'vitest';
import type { Delegation, RemoteAsk, SignedEnvelope } from '../src/gen/fleet';
import { PUSH_PER_MINUTE, REQUEST_WINDOW_MS } from '../src/fleet/limits';
import {
  Harness,
  info,
  startOp,
  startSpace,
  type Device,
} from './fleet-harness';

const TOKEN = 'ExponentPushToken[abc123_-XYZ]';

const errors = (d: Device) => d.take('error').map((e) => e.code);

/** `origin` delegates (or revokes) to `delegate`, signed as `origin`. */
async function delegateTo(
  origin: Device,
  delegate: Device,
  o: Partial<Delegation> & { as?: string } = {},
): Promise<SignedEnvelope> {
  const { as, ...over } = o;
  const body: Delegation = {
    origin_device: origin.id!,
    delegate_device: delegate.id!,
    issued_at_ms: origin.h.now,
    expires_at_ms: 0,
    revoke: false,
    ...over,
  };
  const envelope = await origin.seal('delegate', body, as);
  await origin.send({ type: 'delegate', envelope });
  return envelope;
}

const lists = (d: Device) =>
  d
    .take('delegations')
    .map((m) =>
      m.list.map((e) => (JSON.parse(e.body) as Delegation).delegate_device),
    );

/** mac1 started rs_1 on mac2; the phone is the user's third device. */
async function setup(o: { phoneOnline?: boolean } = {}) {
  const h = new Harness();
  const mac1 = await h.device('user_1', 'mac1');
  const mac2 = await h.device('user_1', 'mac2');
  const phone = await h.phone();
  for (const d of [mac1, mac2, phone]) await d.connect();
  await startSpace(mac1, mac2, 'rs_1');
  await mac2.emit('rs_1', 1, {
    kind: 'started',
    host_device: mac2.id!,
    origin_device: mac1.id!,
    project_id: 'p1',
    project_name: 'theodore',
    name: 'Fix login',
    branch: 'b',
    mode: 'edit',
    parent: null,
    depth: 0,
  });
  await phone.send({ type: 'register_push', provider: 'expo', token: TOKEN });
  if (o.phoneOnline === false) await phone.disconnect();
  for (const d of [mac1, mac2, phone]) if (d.conn.open) d.clear();
  const ask: RemoteAsk = {
    ask_id: 'ask_1',
    space: 'rs_1',
    host_device: mac2.id!,
    from: 'mac2 · Fix login',
    questions: [
      { question: 'Which DB?', options: ['pg', 'sqlite'], multi: false },
    ],
  };
  return { h, mac1, mac2, phone, ask };
}

describe('protocol versions', () => {
  it('accepts 3 and 4, refuses others', async () => {
    const h = new Harness();
    const old = await h.device('user_1', 'old');
    old.protocol = 3;
    await old.connect();
    for (const protocol of [2, 5]) {
      const d = await h.device('user_1', `p${protocol}`);
      d.protocol = protocol;
      await expect(d.connect()).rejects.toThrow(/fleet.version/);
      expect(d.conn.closedWith?.code).toBe(4003);
    }
  });

  it('hides phones from protocol 3 and shows them to 4', async () => {
    const h = new Harness();
    const old = await h.device('user_1', 'old');
    old.protocol = 3;
    const mac = await h.device('user_1', 'mac');
    const phone = await h.phone();
    await old.connect();
    await mac.connect();
    await phone.connect();
    const names = (d: Device) =>
      d
        .take('devices')
        .at(-1)!
        .devices.map((x) => x.info.name)
        .sort();
    expect(names(old)).toEqual(['mac', 'old']);
    expect(names(mac)).toEqual(['iPhone', 'mac', 'old']);
    expect(names(phone)).toEqual(['iPhone', 'mac', 'old']);
  });

  it('sends delegations after welcome to protocol 4 only', async () => {
    const h = new Harness();
    const old = await h.device('user_1', 'old');
    old.protocol = 3;
    const mac = await h.device('user_1', 'mac');
    await old.connect();
    await mac.connect();
    expect(old.take('delegations')).toEqual([]);
    expect(mac.take('delegations')).toEqual([
      { type: 'delegations', list: [] },
    ]);
  });

  it('keeps protocol 3 to its own kinds and messages', async () => {
    const h = new Harness();
    const old = await h.phone();
    old.protocol = 3;
    await expect(old.connect()).rejects.toThrow(/fleet.bad_message/);

    const mac = await h.device('user_1', 'mac');
    mac.protocol = 3;
    await mac.connect();
    await mac.send({
      type: 'announce',
      info: info('mac', { kind: 'web' }),
    });
    await mac.send({ type: 'register_push', provider: 'expo', token: TOKEN });
    expect(errors(mac)).toEqual(['fleet.bad_message', 'fleet.bad_message']);
  });
});

describe('targets', () => {
  it('refuses a request to a phone with fleet.invalid', async () => {
    const { mac1, phone } = await setup();
    const { reqId } = await mac1.request(phone.id!, startOp('rs_9'));
    expect(mac1.take('refused')).toEqual([
      expect.objectContaining({ req_id: reqId, code: 'fleet.invalid' }),
    ]);
    expect(phone.take('request')).toEqual([]);
  });

  it('tells a phone a protocol-3 computer must update first', async () => {
    // A protocol-3 computer never lists phones, so it can't trust one: the
    // phone hears why instead of a dead-end "untrusted" refusal.
    const h = new Harness();
    const old = await h.device('user_1', 'old-mac');
    old.protocol = 3;
    const phone = await h.phone();
    await old.connect();
    await phone.connect();
    const { reqId } = await phone.request(old.id!, {
      op: 'stop',
      space: 'rs_1',
    });
    expect(phone.take('refused')).toEqual([
      expect.objectContaining({
        req_id: reqId,
        code: 'fleet.upgrade_required',
      }),
    ]);
    expect(old.take('request')).toEqual([]);
  });

  it('routes a phone’s request to a computer', async () => {
    const { mac2, phone } = await setup();
    await phone.request(mac2.id!, { op: 'stop', space: 'rs_1' });
    expect(mac2.take('request')).toHaveLength(1);
  });
});

describe('push tokens', () => {
  const tokens = (h: Harness) =>
    h.db.prepare('SELECT device_id, token FROM push_tokens').all();

  it('stores, replaces and removes the sender’s token', async () => {
    const { h, phone } = await setup();
    expect(tokens(h)).toEqual([{ device_id: phone.id, token: TOKEN }]);
    const next = 'ExpoPushToken[zzz]';
    await phone.send({ type: 'register_push', provider: 'expo', token: next });
    expect(tokens(h)).toEqual([{ device_id: phone.id, token: next }]);
    await phone.send({ type: 'register_push', provider: 'expo', token: '' });
    expect(tokens(h)).toEqual([]);
    expect(errors(phone)).toEqual([]);
  });

  it('refuses a malformed token or another provider', async () => {
    const { h, phone } = await setup();
    for (const token of [
      'not-a-token',
      `ExponentPushToken[${'a'.repeat(200)}]`,
      'ExponentPushToken[a b]',
    ]) {
      await phone.send({ type: 'register_push', provider: 'expo', token });
    }
    await phone.send(
      JSON.stringify({ type: 'register_push', provider: 'apns', token: TOKEN }),
    );
    expect(errors(phone)).toEqual(Array(4).fill('fleet.bad_message'));
    expect(tokens(h)).toEqual([{ device_id: phone.id, token: TOKEN }]);
  });

  it('is for phones only', async () => {
    const { mac1 } = await setup();
    await mac1.send({ type: 'register_push', provider: 'expo', token: TOKEN });
    expect(errors(mac1)).toEqual(['fleet.invalid']);
  });

  it('moves a token to the device that registers it last', async () => {
    const { h, phone } = await setup();
    const reinstalled = await h.phone('user_2', 'iPhone again');
    await reinstalled.connect();
    await reinstalled.send({
      type: 'register_push',
      provider: 'expo',
      token: TOKEN,
    });
    expect(tokens(h)).toEqual([{ device_id: reinstalled.id, token: TOKEN }]);
    expect(phone.id).not.toBe(reinstalled.id);
  });
});

describe('delegations', () => {
  it('stores a signed one and tells both devices', async () => {
    const { mac1, phone, mac2 } = await setup();
    const envelope = await delegateTo(mac1, phone);
    const sent = { type: 'delegations', list: [envelope] };
    expect(mac1.take('delegations')).toEqual([sent]);
    expect(phone.take('delegations')).toEqual([sent]);
    expect(mac2.take('delegations')).toEqual([]);
    expect(errors(mac1)).toEqual([]);
  });

  it('checks who signs it, for whom, and when', async () => {
    const { h, mac1, mac2, phone } = await setup();
    const stranger = await h.phone('user_2');
    await stranger.connect();
    // Signed by mac1 but naming mac2 as the origin.
    await delegateTo(mac1, phone, { origin_device: mac2.id!, as: mac2.id! });
    // Its own envelope, but another device's key.
    const forged = await mac2.seal(
      'delegate',
      {
        origin_device: mac1.id!,
        delegate_device: phone.id!,
        issued_at_ms: h.now,
        expires_at_ms: 0,
        revoke: false,
      } satisfies Delegation,
      mac1.id!,
    );
    await mac1.send({ type: 'delegate', envelope: forged });
    await delegateTo(mac1, stranger);
    await delegateTo(mac1, mac1);
    await delegateTo(mac1, phone, {
      issued_at_ms: h.now - REQUEST_WINDOW_MS - 1,
    });
    await delegateTo(mac1, phone, { expires_at_ms: h.now });
    // Signed for another purpose.
    const wrong = await mac1.seal('request', {
      origin_device: mac1.id!,
      delegate_device: phone.id!,
      issued_at_ms: h.now,
      expires_at_ms: 0,
      revoke: false,
    } satisfies Delegation);
    await mac1.send({ type: 'delegate', envelope: wrong });
    expect(errors(mac1)).toEqual([
      'fleet.not_yours',
      'fleet.bad_signature',
      'fleet.not_yours',
      'fleet.invalid',
      'fleet.stale_request',
      'fleet.invalid',
      'fleet.bad_signature',
    ]);
    expect(lists(phone)).toEqual([]);
  });

  it('lets the delegate follow the origin’s spaces, until revoked', async () => {
    const { h, mac1, mac2, phone } = await setup();
    await phone.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    expect(errors(phone)).toEqual(['fleet.not_yours']);

    await delegateTo(mac1, phone);
    await phone.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    expect(phone.stream()).toEqual([1]);
    await mac2.emit('rs_1', 2, { kind: 'status', status: 'running' });
    expect(phone.stream()).toEqual([2]);

    h.now += 1;
    await delegateTo(mac1, phone, { revoke: true });
    expect(lists(phone)).toEqual([[phone.id], []]);
    await mac2.emit('rs_1', 3, { kind: 'status', status: 'waiting' });
    expect(phone.stream()).toEqual([]);
    await phone.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    expect(errors(phone)).toEqual(['fleet.not_yours']);
  });

  it('refuses an older grant after a newer revocation', async () => {
    const { h, mac1, phone } = await setup();
    const t = h.now;
    h.now += 1_000;
    await delegateTo(mac1, phone, { revoke: true });
    await delegateTo(mac1, phone, { issued_at_ms: t });
    expect(errors(mac1)).toEqual(['fleet.stale_request']);
    await phone.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    expect(errors(phone)).toEqual(['fleet.not_yours']);
  });

  it('drops an expired one in the alarm and tells both', async () => {
    const { h, mac1, phone } = await setup();
    await delegateTo(mac1, phone, { expires_at_ms: h.now + 60_000 });
    mac1.clear();
    phone.clear();
    expect(h.scheduled.at(-1)).toBeLessThanOrEqual(h.now + 60_000);
    await h.tick(60_000);
    expect(lists(mac1)).toEqual([[]]);
    expect(lists(phone)).toEqual([[]]);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM delegations').all()).toEqual(
      [{ n: 0 }],
    );
  });

  it('ends with the removal of either device', async () => {
    const { h, mac1, phone } = await setup();
    await delegateTo(mac1, phone);
    await phone.disconnect();
    await mac1.send({ type: 'remove_device', device_id: phone.id! });
    expect(lists(mac1).at(-1)).toEqual([]);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM delegations').all()).toEqual(
      [{ n: 0 }],
    );
    expect(h.db.prepare('SELECT * FROM push_tokens').all()).toEqual([]);
  });

  it('sends the origin’s questions to its delegates too', async () => {
    const { mac1, phone, mac2, ask } = await setup();
    await delegateTo(mac1, phone);
    await mac2.raise(ask);
    expect(mac1.take('ask').map((a) => a.via)).toEqual(['origin']);
    expect(phone.take('ask').map((a) => a.via)).toEqual(['origin']);
  });

  it('moves a question to the delegate you’re at', async () => {
    const { mac1, phone, mac2, ask } = await setup();
    await delegateTo(mac1, phone);
    await phone.send({
      type: 'presence',
      focused: true,
      locked: false,
      idle_ms: 0,
    });
    await mac2.raise(ask);
    expect(phone.take('ask').map((a) => a.via)).toEqual(['active']);
    expect(mac1.take('ask')).toEqual([]);
  });

  it('escalates to a delegate that comes back', async () => {
    const { h, mac1, phone, mac2, ask } = await setup();
    await delegateTo(mac1, phone);
    await phone.disconnect();
    await mac1.disconnect();
    await mac2.raise(ask);
    await h.tick(20_000);
    await phone.connect();
    expect(phone.take('ask').map((a) => a.via)).toEqual(['escalated']);
  });

  it('dismisses a question on a delegate that stops following', async () => {
    const { h, mac1, phone, mac2, ask } = await setup();
    await delegateTo(mac1, phone);
    await mac2.raise(ask);
    phone.clear();
    h.now += 1;
    await delegateTo(mac1, phone, { revoke: true });
    expect(phone.take('dismiss')).toEqual([
      { type: 'dismiss', ask_id: 'ask_1', reason: 'resolved' },
    ]);
  });
});

describe('pushes', () => {
  it('push a question to an offline delegate, as the app reads it', async () => {
    const { h, mac1, phone, mac2, ask } = await setup();
    await delegateTo(mac1, phone);
    await phone.disconnect();
    await mac2.raise(ask);
    expect(h.takePushes()).toEqual([
      {
        to: TOKEN,
        title: 'mac2 · Fix login',
        body: 'Which DB?\n1) pg  2) sqlite',
        categoryId: 'ask_opt2',
        channelId: 'default',
        priority: 'high',
        data: {
          kind: 'ask',
          ask_id: 'ask_1',
          space: 'rs_1',
          host_device: mac2.id,
          options: ['pg', 'sqlite'],
        },
      },
    ]);
  });

  it('skip a phone you’re looking at, reach one you aren’t', async () => {
    const { h, mac1, phone, mac2, ask } = await setup();
    await delegateTo(mac1, phone);
    const look = (focused: boolean) =>
      phone.send({ type: 'presence', focused, locked: false, idle_ms: 0 });
    await look(true);
    await mac2.raise(ask);
    expect(h.takePushes()).toEqual([]);
    await look(false);
    await mac2.raise({ ...ask, ask_id: 'ask_2' });
    expect(h.takePushes().map((p) => p.data.ask_id)).toEqual(['ask_2']);
    // It still shows on the socket.
    expect(phone.take('ask')).toHaveLength(2);
  });

  it('go only to followers, once per question', async () => {
    const { h, mac2, ask } = await setup();
    // No delegation: the phone follows nothing.
    await mac2.raise(ask);
    await h.tick(20_000);
    expect(h.takePushes()).toEqual([]);
  });

  it('wait for the escalation while you’re at the host', async () => {
    const { h, mac1, phone, mac2, ask } = await setup();
    await delegateTo(mac1, phone);
    await mac2.send({
      type: 'presence',
      focused: true,
      locked: false,
      idle_ms: 0,
    });
    await mac2.raise(ask);
    expect(h.takePushes()).toEqual([]);
    await h.tick(20_000);
    expect(h.takePushes()).toHaveLength(1);
    await h.tick(20_000);
    expect(h.takePushes()).toEqual([]);
  });

  it('push a phone that started the space itself', async () => {
    const h = new Harness();
    const mac = await h.device('user_1', 'mac');
    const phone = await h.phone();
    await mac.connect();
    await phone.connect();
    await phone.send({ type: 'register_push', provider: 'expo', token: TOKEN });
    await startSpace(phone, mac, 'rs_p');
    await phone.disconnect();
    await mac.raise({
      ask_id: 'a',
      space: 'rs_p',
      host_device: mac.id!,
      from: '',
      questions: [
        { question: 'Pick', options: ['a', 'b', 'c', 'd'], multi: false },
        { question: 'And', options: [], multi: false },
      ],
    });
    const [p] = h.takePushes();
    // Two questions: no buttons, no options; the space's id stands in for
    // the name it never announced.
    expect(p).toMatchObject({ title: 'mac · rs_p', body: 'Pick' });
    expect(p!.categoryId).toBeUndefined();
    expect(p!.data.options).toEqual([]);
  });

  it('tell followers a space finished or failed, once', async () => {
    const { h, mac1, phone, mac2 } = await setup();
    await delegateTo(mac1, phone);
    await phone.disconnect();
    let seq = 2;
    const status = (s: 'running' | 'idle' | 'failed' | 'waiting') =>
      mac2.emit('rs_1', seq++, { kind: 'status', status: s });
    await status('running');
    await status('idle');
    await status('idle');
    await status('running');
    await status('failed');
    expect(
      h.takePushes().map((p) => [p.title, p.body, p.data.kind, p.categoryId]),
    ).toEqual([
      ['mac2 · Fix login', 'Fix login finished', 'finished', undefined],
      ['mac2 · Fix login', 'Fix login failed', 'finished', undefined],
    ]);
  });

  it('are rate-limited per device', async () => {
    const { h, mac1, phone, mac2, ask } = await setup();
    await delegateTo(mac1, phone);
    await phone.disconnect();
    for (let i = 0; i < PUSH_PER_MINUTE + 5; i++) {
      await mac2.raise({ ...ask, ask_id: `ask_${i}` });
      await mac2.send({ type: 'ask_resolved', ask_id: `ask_${i}` });
    }
    expect(h.takePushes()).toHaveLength(PUSH_PER_MINUTE);
    h.now += 60_000;
    await mac2.raise({ ...ask, ask_id: 'later' });
    expect(h.takePushes()).toHaveLength(1);
  });

  it('drop a token Expo says is gone', async () => {
    const { h, mac1, phone, mac2, ask } = await setup();
    await delegateTo(mac1, phone);
    await phone.disconnect();
    h.pushResult = () => 'unregistered';
    await mac2.raise(ask);
    await h.settle();
    expect(h.db.prepare('SELECT * FROM push_tokens').all()).toEqual([]);
  });

  it('keep a token on any other failure', async () => {
    const { h, mac1, phone, mac2, ask } = await setup();
    await delegateTo(mac1, phone);
    await phone.disconnect();
    h.pushResult = () => 'failed';
    await mac2.raise(ask);
    await h.settle();
    expect(h.db.prepare('SELECT token FROM push_tokens').all()).toEqual([
      { token: TOKEN },
    ]);
  });
});

describe('requests over HTTP', () => {
  it('route like a socket request; the reply comes over the socket', async () => {
    const { h, mac2, phone } = await setup();
    await phone.disconnect();
    const envelope = await phone.envelope(mac2.id!, {
      op: 'answer',
      space: 'rs_1',
      ask_id: 'ask_1',
      answers: [['pg']],
    });
    const reqId = (JSON.parse(envelope.body) as { req_id: string }).req_id;
    const out = await h.hub.requestOverHttp(
      { userId: 'user_1', orgId: 'org_1', expMs: h.now + 60_000 },
      phone.id!,
      envelope,
    );
    expect(out).toEqual({ accepted: true, req_id: reqId });
    const [req] = mac2.take('request');
    expect(req!.envelope).toEqual(envelope);
    await mac2.send({
      type: 'claim',
      req_id: reqId,
      generation: req!.generation,
    });
    await mac2.reply(reqId, { outcome: 'ok', value: null });
    // Held for the phone, delivered on its next welcome.
    await phone.connect();
    expect(phone.take('reply')).toHaveLength(1);
  });

  it('refuse another user’s device, another signer, a phone target', async () => {
    const { h, mac1, mac2, phone } = await setup();
    const caller = { userId: 'user_1', orgId: 'org_1', expMs: h.now + 60_000 };
    const envelope = await phone.envelope(mac2.id!, {
      op: 'stop',
      space: 'rs_1',
    });
    expect(
      await h.hub.requestOverHttp(
        { ...caller, userId: 'user_2' },
        phone.id!,
        envelope,
      ),
    ).toMatchObject({ accepted: false, refused: { code: 'fleet.not_yours' } });
    expect(
      await h.hub.requestOverHttp(caller, mac1.id!, envelope),
    ).toMatchObject({ accepted: false, refused: { code: 'fleet.not_yours' } });
    const toPhone = await mac1.envelope(phone.id!, {
      op: 'stop',
      space: 'rs_1',
    });
    expect(
      await h.hub.requestOverHttp(caller, mac1.id!, toPhone),
    ).toMatchObject({ accepted: false, refused: { code: 'fleet.invalid' } });
    expect(
      await h.hub.requestOverHttp(caller, phone.id!, {
        ...envelope,
        body: '{}',
      }),
    ).toMatchObject({
      accepted: false,
      req_id: null,
      refused: { code: 'fleet.bad_message' },
    });
    expect(mac2.take('request')).toEqual([]);
  });
});
