// Protocol 7: ops on any space of a computer, by its local id (routed on no
// cloud space, refused to older computers), the `sub_space` mirror kept,
// and the `merge` confirm (docs/cloud.md "Fleet").
import { describe, expect, it } from 'vitest';
import type {
  RemoteConfirm,
  RemoteRequest,
  RemoteSpaceEvent,
  SpaceEventBody,
} from '../src/gen/fleet';
import {
  MAX_ANY_SPACE_TEXT_CHARS,
  REQUEST_WINDOW_MS,
} from '../src/fleet/limits';
import { confirmPush } from '../src/fleet/push';
import {
  BadMessage,
  peekConfirm,
  peekRequest,
  protocolFor,
} from '../src/fleet/wire';
import {
  FakeConn,
  Harness,
  info,
  refusals,
  startSpace,
  type Device,
} from './fleet-harness';

const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof BadMessage ? e.code : String(e);
  }
  return null;
};

const requestBody = (op: Record<string, unknown>) =>
  JSON.stringify({
    req_id: 'r1',
    origin_device: 'dev_a',
    target_device: 'dev_b',
    target_key: 'k',
    issued_at_ms: 1,
    op,
  });

const SPACE = 'a1b2c3d4e5f6';
const CHILD = '0123456789ab';

/** One of each op on any space, every field set. */
const OPS: RemoteRequest['op'][] = [
  { op: 'list_spaces', project: null },
  { op: 'read_space', space: SPACE, messages: 50 },
  { op: 'ask_space', space: SPACE, question: 'What did you change?' },
  { op: 'send_to', space: SPACE, message: 'Go on' },
  { op: 'answer_space', space: SPACE, ask: 'ask_1', answers: [['A']] },
  { op: 'merge_child', parent: SPACE, child: CHILD },
];

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
    protocol: 7,
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
  it('reads the ops on any space, on no cloud space', () => {
    for (const op of [
      ...OPS,
      { op: 'list_spaces' },
      { op: 'list_spaces', project: 'p1' },
      { op: 'read_space', space: SPACE },
      { op: 'read_space', space: `rs_${'0'.repeat(32)}`, messages: null },
      { op: 'send_to', space: SPACE, message: '🙂'.repeat(20_000) },
      { op: 'answer_space', space: SPACE, ask: 'a', answers: [] },
    ]) {
      const r = peekRequest(requestBody(op));
      expect(r).toMatchObject({
        op: op.op,
        space: '',
        parent: null,
        depth: 0,
        ask_id: null,
      });
      expect(protocolFor(r.op)).toBe(7);
    }
    expect(protocolFor('confirm')).toBe(6);
    expect(protocolFor('send')).toBe(3);
  });

  it('bounds their fields', () => {
    const long = 'x'.repeat(MAX_ANY_SPACE_TEXT_CHARS + 1);
    for (const op of [
      { op: 'list_spaces', project: 'p'.repeat(101) },
      { op: 'list_spaces', project: 5 },
      { op: 'read_space' },
      { op: 'read_space', space: 's'.repeat(65) },
      { op: 'read_space', space: SPACE, messages: 51 },
      { op: 'read_space', space: SPACE, messages: -1 },
      { op: 'read_space', space: SPACE, messages: 1.5 },
      { op: 'ask_space', space: SPACE },
      { op: 'ask_space', space: SPACE, question: long },
      { op: 'ask_space', space: SPACE, question: '' },
      { op: 'send_to', space: '', message: 'm' },
      { op: 'send_to', space: SPACE, message: long },
      { op: 'answer_space', space: SPACE, answers: [['A']] },
      { op: 'answer_space', space: SPACE, ask: 'a', answers: 'A' },
      { op: 'answer_space', space: SPACE, ask: 'a', answers: ['A'] },
      { op: 'answer_space', space: SPACE, ask: 'a', answers: [[1]] },
      {
        op: 'answer_space',
        space: SPACE,
        ask: 'a',
        answers: Array.from({ length: 21 }, () => ['A']),
      },
      {
        op: 'answer_space',
        space: SPACE,
        ask: 'a',
        answers: [['x'.repeat(4001)]],
      },
      { op: 'merge_child', parent: SPACE },
      { op: 'merge_child', parent: SPACE, child: 'c'.repeat(65) },
    ]) {
      expect(code(() => peekRequest(requestBody(op)))).toBe(
        'fleet.bad_message',
      );
    }
  });

  it('reads a merge confirm', () => {
    const c: RemoteConfirm = {
      confirm_id: 'req_c1',
      host_device: 'dev_h',
      mcp_device: 'dev_mcp',
      action: 'merge',
      mode: 'edit',
      project_name: 'theodore',
      space_name: 'Fix',
      text: 'Add tests',
      expires_at_ms: 0,
    };
    expect(peekConfirm(JSON.stringify(c))).toEqual(c);
    expect(confirmPush('mac', c).body).toBe(
      'wants to merge a sub-space into Fix: Add tests',
    );
  });
});

describe('ops on any space', () => {
  it('route from Claude via the cloud on no space, with its ttl', async () => {
    const h = new Harness();
    const mac = await h.device('user_1', 'mac');
    await mac.connect();
    const claude = await mcpDevice(h);
    const ids: string[] = [];
    for (const op of OPS) ids.push((await claude.request(mac.id!, op)).reqId);
    expect(refusals(claude)).toEqual([]);
    const got = mac.take('request');
    expect(
      got.map((r) => (JSON.parse(r.envelope.body) as RemoteRequest).op.op),
    ).toEqual(OPS.map((o) => o.op));
    for (const id of ids) {
      expect(
        h.db
          .prepare(
            'SELECT space, parent, depth, ask_id, ttl_ms FROM pending WHERE req_id = ?',
          )
          .all(id)[0],
      ).toEqual({
        space: '',
        parent: null,
        depth: 0,
        ask_id: null,
        ttl_ms: REQUEST_WINDOW_MS,
      });
    }
    // Nothing became a cloud space.
    expect(h.db.prepare('SELECT * FROM spaces').all()).toEqual([]);
  });

  it('refuse a computer online below 7 with upgrade_required', async () => {
    const h = new Harness();
    const old = await h.device('user_1', 'old-mac');
    old.protocol = 6;
    await old.connect();
    const mac = await h.device('user_1', 'mac');
    await mac.connect();
    for (const op of OPS) await mac.request(old.id!, op);
    const refused = mac.take('refused');
    expect(refused.map((r) => r.code)).toEqual(
      OPS.map(() => 'fleet.upgrade_required'),
    );
    expect(refused[0]!.message).toBe(
      'that computer runs an older Theodore: update it to reach all its spaces',
    );
    expect(old.take('request')).toEqual([]);
    // Its older ops still route.
    await mac.request(old.id!, { op: 'stop', space: 'rs_x' });
    expect(old.take('request')).toHaveLength(1);
  });

  it('refuse a computer that comes back below 7, deliver on 7', async () => {
    const h = new Harness();
    const mac = await h.device('user_1', 'mac');
    const host = await h.device('user_1', 'host');
    await host.connect();
    await mac.connect();
    await host.disconnect();
    await mac.request(host.id!, OPS[0]!);
    await mac.request(host.id!, { op: 'stop', space: 'rs_x' });
    expect(refusals(mac)).toEqual([]);
    host.protocol = 6;
    await host.connect();
    expect(refusals(mac)).toEqual(['fleet.upgrade_required']);
    expect(
      host
        .take('request')
        .map((r) => (JSON.parse(r.envelope.body) as RemoteRequest).op.op),
    ).toEqual(['stop']);

    await host.disconnect();
    await mac.request(host.id!, OPS[1]!);
    host.protocol = 7;
    await host.connect();
    expect(refusals(mac)).toEqual([]);
    // The unclaimed stop comes again, with the read.
    expect(
      host
        .take('request')
        .map((r) => (JSON.parse(r.envelope.body) as RemoteRequest).op.op),
    ).toEqual(['stop', 'read_space']);
  });
});

// Protocol 9: archive_space / unarchive_space, on a space the target hosts
// for the origin, routed like stop.
describe('archive_space / unarchive_space', () => {
  const ARCHIVE: RemoteRequest['op'][] = [
    { op: 'archive_space', space: 'rs_1' },
    { op: 'unarchive_space', space: 'rs_1' },
  ];

  it('are read on their space and need protocol 9', () => {
    for (const op of ARCHIVE) {
      const r = peekRequest(requestBody(op));
      expect(r).toMatchObject({ op: op.op, space: 'rs_1', ask_id: null });
      expect(protocolFor(r.op)).toBe(9);
    }
    expect(protocolFor('stop')).toBe(3);
    expect(code(() => peekRequest(requestBody({ op: 'archive_space' })))).toBe(
      'fleet.bad_message',
    );
  });

  it('route to a protocol-9 host, and refuse an older one in words', async () => {
    const h = new Harness();
    const mac1 = await h.device('user_1', 'mac1');
    const mac2 = await h.device('user_1', 'mac2');
    await mac1.connect();
    await mac2.connect();
    await startSpace(mac1, mac2, 'rs_1');
    for (const op of ARCHIVE) await mac1.request(mac2.id!, op);
    expect(refusals(mac1)).toEqual([]);
    expect(
      mac2
        .take('request')
        .map((r) => (JSON.parse(r.envelope.body) as RemoteRequest).op.op),
    ).toEqual(['archive_space', 'unarchive_space']);

    const old = await h.device('user_1', 'old-mac');
    old.protocol = 8;
    await old.connect();
    await startSpace(mac1, old, 'rs_2');
    await mac1.request(old.id!, { op: 'archive_space', space: 'rs_2' });
    const refused = mac1.take('refused');
    expect(refused.map((r) => r.code)).toEqual(['fleet.upgrade_required']);
    expect(refused[0]!.message).toBe(
      'that computer runs an older Theodore: update it to archive its spaces from another device',
    );
    expect(old.take('request')).toEqual([]);
    // Its older ops still route.
    await mac1.request(old.id!, { op: 'stop', space: 'rs_2' });
    expect(old.take('request')).toHaveLength(1);
  });
});

describe('the sub_space mirror', () => {
  it('is kept, the latest per sub-space', async () => {
    const h = new Harness();
    const mac1 = await h.device('user_1', 'mac1');
    const mac2 = await h.device('user_1', 'mac2');
    await mac1.connect();
    await mac2.connect();
    await startSpace(mac1, mac2, 'rs_1');
    await mac1.disconnect();
    const sub = (status: string): RemoteSpaceEvent => ({
      kind: 'mirror',
      model: 'sub_space',
      id: CHILD,
      data: {
        space: CHILD,
        parent: 'rs_1',
        title: 'Tests',
        status,
        mode: 'edit',
        done: false,
      },
    });
    await mac2.emit('rs_1', 1, sub('running'));
    h.now += 25;
    await mac2.emit('rs_1', 2, sub('idle'));
    expect(mac2.take('error')).toEqual([]);
    await mac1.connect();
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    const got = mac1.take('space_event').map((m) => {
      const b = JSON.parse(m.envelope.body) as SpaceEventBody;
      return `${b.seq} ${b.event.kind === 'mirror' ? b.event.model : ''}`;
    });
    expect(got).toEqual(['2 sub_space']);
  });
});
