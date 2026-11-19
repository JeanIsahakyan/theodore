// Protocol 6: a host's confirms (Claude via the cloud waiting for a
// person's yes) relayed to its delegates, and the `confirm` /
// `set_mcp_auto` ops (docs/cloud.md "Confirms").
import { describe, expect, it } from 'vitest';
import type {
  Delegation,
  McpAutoState,
  RemoteConfirm,
  SignedEnvelope,
} from '../src/gen/fleet';
import {
  CONFIRM_TEXT_MAX,
  MAX_CONFIRMS_PER_USER,
  MAX_MCP_AUTO,
  PENDING_TTL_MS,
  REQUEST_WINDOW_MS,
} from '../src/fleet/limits';
import { confirmPush } from '../src/fleet/push';
import {
  BadMessage,
  parseClient,
  peekConfirm,
  peekRequest,
} from '../src/fleet/wire';
import { FakeConn, Harness, info, type Device } from './fleet-harness';

const TOKEN = 'ExponentPushToken[abc123_-XYZ]';

const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof BadMessage ? e.code : String(e);
  }
  return null;
};

const errors = (d: Device) => d.take('error').map((e) => e.code);

const requestBody = (op: Record<string, unknown>) =>
  JSON.stringify({
    req_id: 'r1',
    origin_device: 'dev_a',
    target_device: 'dev_b',
    target_key: 'k',
    issued_at_ms: 1,
    op,
  });

const confirmBody = (
  host: string,
  over: Partial<RemoteConfirm> = {},
): RemoteConfirm => ({
  confirm_id: 'req_c1',
  host_device: host,
  mcp_device: 'dev_mcp',
  action: 'start',
  mode: 'edit',
  project_name: 'theodore',
  space_name: null,
  text: 'Fix the login bug',
  expires_at_ms: 0,
  ...over,
});

/** `origin` delegates (or revokes) to `delegate`, signed as `origin`. */
async function delegateTo(
  origin: Device,
  delegate: Device,
  over: Partial<Delegation> = {},
) {
  const body: Delegation = {
    origin_device: origin.id!,
    delegate_device: delegate.id!,
    issued_at_ms: origin.h.now,
    expires_at_ms: 0,
    revoke: false,
    ...over,
  };
  await origin.send({
    type: 'delegate',
    envelope: await origin.seal('delegate', body),
  });
}

/** The host's confirm, signed as the host. */
async function raiseConfirm(
  host: Device,
  over: Partial<RemoteConfirm> = {},
  o: { domain?: 'confirm' | 'ask'; as?: string } = {},
): Promise<SignedEnvelope> {
  const body = confirmBody(host.id!, {
    expires_at_ms: host.h.now + 60_000,
    ...over,
  });
  const envelope = await host.seal(o.domain ?? 'confirm', body, o.as);
  await host.send({ type: 'confirm', envelope });
  return envelope;
}

const confirmIds = (d: Device) =>
  d
    .take('confirm')
    .map((m) => (JSON.parse(m.envelope.body) as RemoteConfirm).confirm_id);

const dismissed = (d: Device) =>
  d.take('confirm_dismissed').map((m) => m.confirm_id);

/**
 * mac (the host) delegates to a phone and to mac2 (protocol 6) and to an
 * old phone (protocol 5); other is a device mac doesn't delegate to.
 */
async function setup() {
  const h = new Harness();
  const mac = await h.device('user_1', 'mac');
  const mac2 = await h.device('user_1', 'mac2');
  const phone = await h.phone('user_1', 'iPhone');
  const oldPhone = await h.phone('user_1', 'old');
  oldPhone.protocol = 5;
  const other = await h.device('user_1', 'other');
  for (const d of [mac, mac2, phone, oldPhone, other]) await d.connect();
  await phone.send({ type: 'register_push', provider: 'expo', token: TOKEN });
  for (const d of [phone, mac2, oldPhone]) await delegateTo(mac, d);
  for (const d of [mac, mac2, phone, oldPhone, other]) d.clear();
  return { h, mac, mac2, phone, oldPhone, other };
}

/** The cloud's own MCP device, in process: hello as kind `mcp`. */
async function mcpDevice(h: Harness): Promise<Device> {
  const d = await h.device('user_1', 'Claude');
  const conn = new FakeConn('user_1');
  h.conns.push(conn);
  await h.hub.open(
    conn,
    { userId: 'user_1', orgId: 'org_1', expMs: h.now + 3_600_000 },
    true,
  );
  const challenge = conn.sent.shift() as { nonce: string };
  d.conn = conn;
  await d.send({
    type: 'hello',
    protocol: 6,
    device_id: null,
    public_key: d.publicKey,
    signature: await d.signHello(challenge.nonce),
    info: info('Claude', {
      kind: 'mcp',
      projects: [],
      accepts_remote: false,
      max_mode: 'edit',
    }),
    spaces: [],
  });
  d.id = d.take('welcome')[0]!.device_id;
  return d;
}

describe('wire', () => {
  it('reads the confirm and set_mcp_auto ops, on no space', () => {
    for (const op of [
      { op: 'confirm', confirm_id: 'req_1', allow: true },
      { op: 'set_mcp_auto', mcp_device: 'dev_m', auto: 'edit' },
      { op: 'set_mcp_auto', mcp_device: 'dev_m', auto: 'full', until_ms: 5 },
      { op: 'set_mcp_auto', mcp_device: 'dev_m', auto: 'off', until_ms: null },
    ]) {
      const r = peekRequest(requestBody(op));
      expect(r.op).toBe(op.op);
      expect(r.space).toBe('');
    }
  });

  it('bounds their fields', () => {
    for (const op of [
      { op: 'confirm', confirm_id: 'req_1' },
      { op: 'confirm', confirm_id: '', allow: true },
      { op: 'confirm', confirm_id: 'req_1', allow: 'yes' },
      { op: 'set_mcp_auto', mcp_device: 'd'.repeat(65), auto: 'edit' },
      { op: 'set_mcp_auto', mcp_device: 'dev_m', auto: 'always' },
      { op: 'set_mcp_auto', mcp_device: 'dev_m', auto: 'edit', until_ms: -1 },
    ]) {
      expect(code(() => peekRequest(requestBody(op)))).toBe(
        'fleet.bad_message',
      );
    }
  });

  it('takes confirm frames on protocol 6 only', () => {
    const env = { device_id: 'd', body: '{}', signature: 's' };
    const frames = [
      JSON.stringify({ type: 'confirm', envelope: env }),
      JSON.stringify({ type: 'confirm_resolved', confirm_id: 'req_1' }),
    ];
    for (const f of frames) {
      expect(code(() => parseClient(f, 6))).toBeNull();
      expect(code(() => parseClient(f, 5))).toBe('fleet.bad_message');
    }
  });

  it('reads a confirm with every field bounded', () => {
    const ok = confirmBody('dev_h', { expires_at_ms: 5 });
    expect(peekConfirm(JSON.stringify(ok))).toEqual(ok);
    // Characters, as Rust counts them, not UTF-16 units.
    const emoji = { ...ok, text: '🙂'.repeat(CONFIRM_TEXT_MAX) };
    expect(peekConfirm(JSON.stringify(emoji)).text).toBe(emoji.text);
    for (const bad of [
      { ...ok, text: 'x'.repeat(CONFIRM_TEXT_MAX + 1) },
      { ...ok, project_name: 'p'.repeat(201) },
      { ...ok, space_name: 's'.repeat(201) },
      { ...ok, action: 'stop' },
      { ...ok, mode: 'yolo' },
      { ...ok, expires_at_ms: -1 },
      { ...ok, host_device: 'h'.repeat(65) },
    ]) {
      expect(code(() => peekConfirm(JSON.stringify(bad)))).toBe(
        'fleet.bad_message',
      );
    }
  });

  it('keeps a protocol-6 host’s mcp_auto, bounded', () => {
    const auto: McpAutoState[] = [
      { device_id: 'dev_m', auto: 'edit', until_ms: 9 },
      { device_id: 'dev_n', auto: 'full', until_ms: null },
    ];
    const frame = (mcp_auto: unknown) =>
      JSON.stringify({ type: 'announce', info: { ...info('mac'), mcp_auto } });
    expect(parseClient(frame(auto), 6)).toMatchObject({
      info: { mcp_auto: auto },
    });
    expect(parseClient(frame(auto), 5)).toMatchObject({
      info: { mcp_auto: [] },
    });
    const many = Array.from({ length: MAX_MCP_AUTO + 1 }, () => auto[0]);
    for (const bad of [
      many,
      [{ device_id: 'dev_m', auto: 'always' }],
      [{ device_id: 'd'.repeat(65), auto: 'off' }],
      [{ device_id: 'dev_m', auto: 'off', until_ms: 1.5 }],
    ]) {
      expect(code(() => parseClient(frame(bad), 6))).toBe('fleet.bad_message');
    }
  });

  it('relays mcp_auto in the devices list', async () => {
    const h = new Harness();
    const mac = await h.device('user_1', 'mac');
    const phone = await h.phone();
    const auto: McpAutoState[] = [
      { device_id: 'dev_m', auto: 'full', until_ms: h.now + 60_000 },
    ];
    mac.infoOver = { mcp_auto: auto };
    await mac.connect();
    await phone.connect();
    const listed = phone
      .take('devices')
      .at(-1)!
      .devices.find((d) => d.device_id === mac.id);
    expect(listed?.info.mcp_auto).toEqual(auto);
  });
});

describe('confirm and set_mcp_auto requests', () => {
  it('route to a protocol-6 host on no space, with the usual ttl', async () => {
    const { h, mac, phone, mac2 } = await setup();
    const { reqId } = await phone.request(mac.id!, {
      op: 'confirm',
      confirm_id: 'req_c1',
      allow: true,
    });
    await mac2.request(mac.id!, {
      op: 'set_mcp_auto',
      mcp_device: 'dev_m',
      auto: 'edit',
      until_ms: null,
    });
    expect(mac.take('request')).toHaveLength(2);
    expect(phone.take('refused')).toEqual([]);
    const row = h.db
      .prepare('SELECT space, ttl_ms FROM pending WHERE req_id = ?')
      .all(reqId)[0];
    expect(row).toEqual({ space: '', ttl_ms: PENDING_TTL_MS });
  });

  it('refuse a protocol-5 host with upgrade_required', async () => {
    const h = new Harness();
    const old = await h.device('user_1', 'old-mac');
    old.protocol = 5;
    const phone = await h.phone();
    await old.connect();
    await phone.connect();
    for (const op of [
      { op: 'confirm' as const, confirm_id: 'req_c1', allow: false },
      {
        op: 'set_mcp_auto' as const,
        mcp_device: 'dev_m',
        auto: 'off' as const,
      },
    ]) {
      await phone.request(old.id!, op);
    }
    expect(phone.take('refused').map((r) => r.code)).toEqual([
      'fleet.upgrade_required',
      'fleet.upgrade_required',
    ]);
    expect(old.take('request')).toEqual([]);
  });

  it('refuse Claude via the cloud itself', async () => {
    const h = new Harness();
    const mac = await h.device('user_1', 'mac');
    await mac.connect();
    const claude = await mcpDevice(h);
    await claude.request(mac.id!, {
      op: 'confirm',
      confirm_id: 'req_c1',
      allow: true,
    });
    await claude.request(mac.id!, {
      op: 'set_mcp_auto',
      mcp_device: claude.id!,
      auto: 'full',
    });
    expect(claude.take('refused').map((r) => r.code)).toEqual([
      'fleet.not_yours',
      'fleet.not_yours',
    ]);
    expect(mac.take('request')).toEqual([]);
  });
});

describe('confirms', () => {
  it('go to the host’s live delegates on protocol 6 only', async () => {
    const { mac, mac2, phone, oldPhone, other } = await setup();
    const sent = await raiseConfirm(mac);
    expect(phone.take('confirm')).toEqual([
      { type: 'confirm', envelope: sent },
    ]);
    expect(confirmIds(mac2)).toEqual(['req_c1']);
    expect(oldPhone.take('confirm')).toEqual([]);
    expect(other.take('confirm')).toEqual([]);
    expect(mac.take('confirm')).toEqual([]);
    expect(errors(mac)).toEqual([]);
  });

  it('never go to an mcp delegate', async () => {
    const { h, mac } = await setup();
    const claude = await mcpDevice(h);
    await delegateTo(mac, claude);
    claude.clear();
    await raiseConfirm(mac);
    expect(claude.take('confirm')).toEqual([]);
  });

  it('check who signs them, and how many are open', async () => {
    const { h, mac, mac2, phone } = await setup();
    // Not this host's, or not signed for confirms.
    await raiseConfirm(mac2, {}, { as: mac.id });
    await raiseConfirm(mac, { host_device: mac2.id! });
    await raiseConfirm(mac, {}, { domain: 'ask' });
    await raiseConfirm(mac, { expires_at_ms: h.now });
    expect(errors(mac2)).toEqual(['fleet.not_yours']);
    expect(errors(mac)).toEqual([
      'fleet.not_yours',
      'fleet.bad_signature',
      'fleet.invalid',
    ]);
    // A phone holds none.
    await raiseConfirm(phone);
    expect(errors(phone)).toEqual(['fleet.invalid']);
    expect(confirmIds(mac2)).toEqual([]);
    // The same one again: already open, not shown twice.
    await raiseConfirm(mac);
    await raiseConfirm(mac);
    expect(confirmIds(mac2)).toEqual(['req_c1']);
    // Another host can't take its id.
    await raiseConfirm(mac2);
    expect(errors(mac2)).toEqual(['fleet.not_yours']);
    for (let i = 1; i < MAX_CONFIRMS_PER_USER; i++) {
      await raiseConfirm(mac, { confirm_id: `req_c${i + 1}` });
    }
    expect(errors(mac)).toEqual([]);
    await raiseConfirm(mac, { confirm_id: 'req_over' });
    expect(errors(mac)).toEqual(['fleet.busy']);
  });

  it('come again after a delegate’s welcome, and to a new delegate', async () => {
    const { h, mac, phone, other } = await setup();
    await raiseConfirm(mac);
    await phone.disconnect();
    await phone.connect();
    expect(confirmIds(phone)).toEqual(['req_c1']);
    await delegateTo(mac, other);
    expect(confirmIds(other)).toEqual(['req_c1']);
    // Past its expiry, nothing comes.
    h.now += 60_000;
    await phone.disconnect();
    await phone.connect();
    expect(confirmIds(phone)).toEqual([]);
  });

  it('are dismissed where they showed when the host resolves them', async () => {
    const { h, mac, mac2, phone, oldPhone } = await setup();
    await raiseConfirm(mac);
    for (const d of [mac2, phone]) d.clear();
    // Only its host resolves it; an unknown id is nothing.
    await mac2.send({ type: 'confirm_resolved', confirm_id: 'req_c1' });
    expect(errors(mac2)).toEqual(['fleet.not_yours']);
    await mac.send({ type: 'confirm_resolved', confirm_id: 'req_nope' });
    expect(errors(mac)).toEqual([]);
    await mac.send({ type: 'confirm_resolved', confirm_id: 'req_c1' });
    expect(dismissed(phone)).toEqual(['req_c1']);
    expect(dismissed(mac2)).toEqual(['req_c1']);
    expect(oldPhone.take('confirm_dismissed')).toEqual([]);
    expect(h.db.prepare('SELECT * FROM confirms').all()).toEqual([]);
  });

  it('are dismissed when they lapse', async () => {
    const { h, mac, phone } = await setup();
    await raiseConfirm(mac, { expires_at_ms: h.now + 30_000 });
    phone.clear();
    expect(h.scheduled.at(-1)).toBe(h.now + 30_000);
    await h.tick(29_000);
    expect(dismissed(phone)).toEqual([]);
    await h.tick(1_000);
    expect(dismissed(phone)).toEqual(['req_c1']);
    expect(h.db.prepare('SELECT * FROM confirms').all()).toEqual([]);
  });

  it('live at most the request window here', async () => {
    const { h, mac, phone } = await setup();
    await raiseConfirm(mac, { expires_at_ms: h.now + 3_600_000 });
    phone.clear();
    await h.tick(REQUEST_WINDOW_MS);
    expect(dismissed(phone)).toEqual(['req_c1']);
  });

  it('are dismissed on a delegate that stops following', async () => {
    const { h, mac, mac2, phone } = await setup();
    await raiseConfirm(mac);
    for (const d of [mac2, phone]) d.clear();
    await delegateTo(mac, phone, { revoke: true });
    expect(dismissed(phone)).toEqual(['req_c1']);
    expect(dismissed(mac2)).toEqual([]);
    // An expired delegation the same way.
    await delegateTo(mac, mac2, { expires_at_ms: h.now + 1_000 });
    await h.tick(1_000);
    expect(dismissed(mac2)).toEqual(['req_c1']);
    // And no longer sent after a welcome.
    await phone.disconnect();
    await phone.connect();
    expect(confirmIds(phone)).toEqual([]);
  });

  it('go with their host when it is removed', async () => {
    const { h, mac, phone } = await setup();
    await raiseConfirm(mac);
    phone.clear();
    await mac.disconnect();
    await phone.send({ type: 'remove_device', device_id: mac.id! });
    expect(dismissed(phone)).toEqual(['req_c1']);
    expect(h.db.prepare('SELECT * FROM confirms').all()).toEqual([]);
  });

  it('push a delegate away from a screen, once, as the app reads it', async () => {
    const { h, mac, phone } = await setup();
    await phone.disconnect();
    await raiseConfirm(mac);
    expect(h.takePushes()).toEqual([
      {
        to: TOKEN,
        title: 'Claude via cloud · mac',
        body: 'wants to start an Edit space in theodore: Fix the login bug',
        categoryId: 'confirm',
        channelId: 'default',
        priority: 'high',
        data: {
          kind: 'confirm',
          confirm_id: 'req_c1',
          host_device: mac.id,
          space: '',
          ask_id: '',
          options: [],
        },
      },
    ]);
    await raiseConfirm(mac);
    expect(h.takePushes()).toEqual([]);
  });

  it('skip a phone you’re looking at', async () => {
    const { h, mac, phone } = await setup();
    await phone.send({
      type: 'presence',
      focused: true,
      locked: false,
      idle_ms: 0,
    });
    await raiseConfirm(mac);
    expect(h.takePushes()).toEqual([]);
  });
});

describe('confirmPush', () => {
  const at = (over: Partial<RemoteConfirm>) =>
    confirmPush('mac', confirmBody('dev_h', over)).body;

  it('says what Claude wants to do', () => {
    expect(at({ mode: 'run', project_name: null, text: 'go' })).toBe(
      'wants to start a Run space in a project: go',
    );
    expect(at({ mode: 'plan', text: 'x' })).toBe(
      'wants to start a Plan space in theodore: x',
    );
    expect(at({ mode: 'ask', text: 'x' })).toBe(
      'wants to start an Ask space in theodore: x',
    );
    expect(at({ action: 'send', space_name: 'Fix login', text: 'more' })).toBe(
      'wants to send to Fix login in Edit: more',
    );
    expect(at({ action: 'send', text: '' })).toBe(
      'wants to send to a space in Edit',
    );
    expect(
      at({ action: 'approve_plan', mode: 'run', space_name: 'S', text: 'p' }),
    ).toBe('wants to approve the plan in S (Run): p');
  });

  it('clips the body to 180 chars on one line', () => {
    const body = at({ text: 'word\n'.repeat(100) });
    expect(body.length).toBe(180);
    expect(body).not.toContain('\n');
    expect(body.endsWith('…')).toBe(true);
  });
});
