// The cloud's MCP device on a real hub: trust both ways, signed requests
// to pinned computers only, verified replies and events, refusals as codes,
// and `mcp` kept away from sockets and older protocols.
import { describe, expect, it } from 'vitest';
import type { Loose } from './loose';
import type {
  RemoteRequest,
  ServerMessage,
  SpaceEventBody,
} from '../src/gen/fleet';
import { verifyEnvelope } from '../src/fleet/wire';
import { fingerprint } from '../src/mcp/crypto';
import { APPROVED_TEXT, ONLINE_MS } from '../src/mcp/fleet';
import { callTool } from '../src/mcp/tools';
import { Harness, type Device } from './fleet-harness';

const C = { userId: 'user_1', orgId: 'org_1' };

type Req = Extract<ServerMessage, { type: 'request' }>;

async function tool(h: Harness, name: string, args: unknown = {}) {
  const r = await callTool(h.mcp!, C, name, args);
  return {
    error: r.isError === true,
    v: JSON.parse(r.content[0]!.text) as Loose,
  };
}

async function eventually<T>(f: () => T | undefined): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const v = f();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timed out');
}

/** The next request `d` gets, its body parsed. */
async function nextRequest(
  d: Device,
): Promise<{ req: Req; body: RemoteRequest }> {
  const req = await eventually(() => d.take('request')[0]);
  return { req, body: JSON.parse(req.envelope.body) as RemoteRequest };
}

async function setup(o: { trust?: boolean; replyWaitMs?: number } = {}) {
  const h = new Harness(undefined, {
    mcp: true,
    replyWaitMs: o.replyWaitMs ?? 2000,
  });
  const mac = await h.device('user_1', 'mac');
  await mac.connect();
  if (o.trust !== false) {
    const t = await tool(h, 'device_trust', {
      device: mac.id,
      fingerprint: await fingerprint(mac.publicKey),
    });
    expect(t.error).toBe(false);
  }
  return { h, mac, mcpId: () => mcpDevice(h).device_id };
}

const mcpDevice = (h: Harness) =>
  h.hub.listDevices('user_1').find((d) => d.info.kind === 'mcp')!;

/** space_start answered by `mac`: claimed, then `reply`. */
async function started(h: Harness, mac: Device, mode = 'plan') {
  const p = tool(h, 'space_start', {
    device: mac.id,
    project: 'p1',
    goal: 'fix the bug',
    mode,
  });
  const { req, body } = await nextRequest(mac);
  await mac.send({
    type: 'claim',
    req_id: body.req_id,
    generation: req.generation,
  });
  mac.take('claim_result');
  const op = body.op as Extract<RemoteRequest['op'], { op: 'start_space' }>;
  await mac.reply(body.req_id, {
    outcome: 'ok',
    value: { space: op.space, name: 'Fix', branch: 'fix-bug' },
  });
  const out = await p;
  return { out, space: op.space, body };
}

/** `mac` claims the next request (a send) and answers it as queued. */
async function queuedReply(mac: Device, position: number) {
  const { req, body } = await nextRequest(mac);
  await mac.send({
    type: 'claim',
    req_id: body.req_id,
    generation: req.generation,
  });
  mac.take('claim_result');
  await mac.reply(body.req_id, {
    outcome: 'ok',
    value: { message: 'm2', queued: true, position },
  });
  return body;
}

describe('MCP device', () => {
  it('is a device of kind mcp, with a fingerprint to compare', async () => {
    const { h, mac } = await setup({ trust: false });
    const s = await tool(h, 'theodore_status');
    const dev = mcpDevice(h);
    expect(s.v.device.id).toBe(dev.device_id);
    expect(s.v.device.fingerprint).toBe(await fingerprint(dev.public_key));
    expect(s.v.organization).toBe('org_1');
    expect(s.v.computers).toEqual([
      { device: mac.id, name: 'mac', online: true, trusted_here: 'no' },
    ]);
    expect(dev.online).toBe(true);
    // The computer lists it, for its user to trust.
    const list = mac.take('devices').at(-1)!.devices;
    expect(list.find((d) => d.device_id === dev.device_id)?.info.kind).toBe(
      'mcp',
    );
  });

  it('pins a computer only with its fingerprint', async () => {
    const { h, mac } = await setup({ trust: false });
    const wrong = await tool(h, 'device_trust', {
      device: mac.id,
      fingerprint: '0000 0000 0000 0000 0000 0000 0000 0000',
    });
    expect(wrong.error).toBe(true);
    expect(wrong.v.error.code).toBe('mcp.fingerprint_mismatch');
    // Untrusted: nothing is signed for it.
    const start = await tool(h, 'space_start', {
      device: mac.id,
      project: 'p1',
      goal: 'x',
      mode: 'ask',
    });
    expect(start.v.error.code).toBe('mcp.untrusted_device');
    expect(mac.take('request')).toEqual([]);
    // Fingerprints aren't listed: only the one read on the computer works.
    const listed = await tool(h, 'devices_list');
    expect(JSON.stringify(listed.v)).not.toContain(
      (await fingerprint(mac.publicKey)).slice(0, 9),
    );
    // By name too, case aside: Claude knows computers by what they're called.
    const ok = await tool(h, 'device_trust', {
      device: 'MAC',
      fingerprint: (await fingerprint(mac.publicKey)).toUpperCase(),
    });
    expect(ok.v).toEqual({ device: mac.id, name: 'mac', trusted_here: 'yes' });
    const projects = await tool(h, 'projects_list', { device: 'mac' });
    expect(projects.v.device).toBe(mac.id);
    const nobody = await tool(h, 'projects_list', { device: 'pc' });
    expect(nobody.v.error.code).toBe('mcp.unknown_device');
  });

  it('starts a space with a request signed by its key for the pinned key', async () => {
    const { h, mac, mcpId } = await setup();
    const { out, space, body } = await started(h, mac);
    expect(out.error).toBe(false);
    expect(out.v.result).toBe('ok');
    expect(out.v.space).toMatchObject({
      space,
      status: 'running',
      name: 'Fix',
      branch: 'fix-bug',
      computer: { device: mac.id, name: 'mac' },
    });
    expect(body.origin_device).toBe(mcpId());
    expect(body.target_key).toBe(mac.publicKey);
    expect(body.op).toMatchObject({
      op: 'start_space',
      mode: 'plan',
      depth: 0,
    });
  });

  it('is not settled on the idle a host sends before the goal turn runs', async () => {
    const { h, mac, mcpId } = await setup();
    const { space } = await started(h, mac);
    const host = mac.id!;
    await mac.emit(space, 1, {
      kind: 'started',
      host_device: host,
      origin_device: mcpId(),
      project_id: 'p1',
      project_name: 'theodore',
      name: 'Fix',
      branch: 'fix-bug',
      mode: 'plan',
      depth: 0,
    });
    await mac.emit(space, 2, { kind: 'status', status: 'idle' });
    const early = await tool(h, 'space_wait', {
      spaces: [space],
      timeout_ms: 300,
    });
    expect(early.v.settled).toBe(false);
    expect(early.v.spaces[0].status).toBe('running');
    await mac.emit(space, 3, { kind: 'turn_started', turn: 1, text: 'fix' });
    // The turn began a moment before the host says `running`: still owed.
    const begun = await tool(h, 'space_wait', {
      spaces: [space],
      timeout_ms: 300,
    });
    expect(begun.v.settled).toBe(false);
    await mac.emit(space, 4, { kind: 'reply', turn: 1, text: 'done' });
    await mac.emit(space, 5, { kind: 'turn_ended', turn: 1, outcome: 'done' });
    await mac.emit(space, 6, { kind: 'status', status: 'idle' });
    const w = await tool(h, 'space_wait', {
      spaces: [space],
      timeout_ms: 2000,
    });
    expect(w.v.settled).toBe(true);
    // The host titles the space after its first turn: the name follows.
    await mac.emit(space, 7, {
      kind: 'mirror',
      model: 'space',
      id: space,
      data: {
        id: space,
        title: 'Fix the login bug',
        name: 'fix',
        turn_log: [],
      },
    });
    const r = await tool(h, 'space_read', { space });
    expect(r.v.name).toBe('Fix the login bug');
  });

  it('is not settled while the start is unanswered and the host says idle', async () => {
    const { h, mac, mcpId } = await setup({ replyWaitMs: 100 });
    const p = tool(h, 'space_start', {
      device: mac.id,
      project: 'p1',
      goal: 'fix the bug',
      mode: 'ask',
    });
    const { req, body } = await nextRequest(mac);
    await mac.send({
      type: 'claim',
      req_id: body.req_id,
      generation: req.generation,
    });
    mac.take('claim_result');
    // The worktree takes a while: space_start gives up waiting first.
    const out = await p;
    expect(out.v.result).toBe('pending');
    const op = body.op as Extract<RemoteRequest['op'], { op: 'start_space' }>;
    const space = op.space;
    await mac.emit(space, 1, {
      kind: 'started',
      host_device: mac.id!,
      origin_device: mcpId(),
      project_id: 'p1',
      project_name: 'theodore',
      name: 'Fix',
      branch: 'fix-bug',
      mode: 'ask',
      depth: 0,
    });
    await mac.emit(space, 2, { kind: 'status', status: 'idle' });
    const early = await tool(h, 'space_wait', {
      spaces: [space],
      timeout_ms: 300,
    });
    expect(early.v.settled).toBe(false);
    await mac.reply(body.req_id, {
      outcome: 'ok',
      value: { space, name: 'Fix', branch: 'fix-bug' },
    });
    await mac.emit(space, 3, { kind: 'turn_started', turn: 1, text: 'fix' });
    await mac.emit(space, 4, { kind: 'turn_ended', turn: 1, outcome: 'done' });
    await mac.emit(space, 5, { kind: 'status', status: 'idle' });
    const w = await tool(h, 'space_wait', {
      spaces: [space],
      timeout_ms: 2000,
    });
    expect(w.v.settled).toBe(true);
  });

  it('reports a send queued behind the running turn, and waits for its turn', async () => {
    const { h, mac, mcpId } = await setup();
    const { space } = await started(h, mac);
    await mac.emit(space, 1, {
      kind: 'started',
      host_device: mac.id!,
      origin_device: mcpId(),
      project_id: 'p1',
      project_name: 'theodore',
      name: 'Fix',
      branch: 'fix-bug',
      mode: 'plan',
      depth: 0,
    });
    await mac.emit(space, 2, { kind: 'turn_started', turn: 1, text: 'fix' });
    await mac.emit(space, 3, { kind: 'status', status: 'running' });
    const p = tool(h, 'space_send', { space, message: 'and then this' });
    const body = await queuedReply(mac, 1);
    expect(body.op).toMatchObject({ op: 'send', text: 'and then this' });
    const out = await p;
    expect(out.v).toMatchObject({ space, result: 'queued', position: 1 });
    expect(out.v.note).toContain(
      'queued (position 1), runs after the current turn',
    );

    // The running turn ends: idle a moment before the queued one starts.
    await mac.emit(space, 4, { kind: 'reply', turn: 1, text: 'first' });
    await mac.emit(space, 5, { kind: 'turn_ended', turn: 1, outcome: 'done' });
    await mac.emit(space, 6, { kind: 'status', status: 'idle' });
    const gap = await tool(h, 'space_wait', {
      spaces: [space],
      timeout_ms: 300,
    });
    expect(gap.v.settled).toBe(false);
    expect(gap.v.spaces[0].status).toBe('running');
    await mac.emit(space, 7, {
      kind: 'turn_started',
      turn: 2,
      text: 'and then this',
    });
    await mac.emit(space, 8, { kind: 'reply', turn: 2, text: 'second' });
    await mac.emit(space, 9, { kind: 'turn_ended', turn: 2, outcome: 'done' });
    await mac.emit(space, 10, { kind: 'status', status: 'idle' });
    const w = await tool(h, 'space_wait', {
      spaces: [space],
      timeout_ms: 2000,
    });
    expect(w.v.settled).toBe(true);
  });

  it('settles a queued send once the host holds its queue', async () => {
    const { h, mac } = await setup();
    const { space } = await started(h, mac);
    await mac.emit(space, 1, { kind: 'status', status: 'running' });
    const p = tool(h, 'space_send', { space, message: 'later' });
    await queuedReply(mac, 1);
    expect((await p).v.result).toBe('queued');
    // Stopped: the host holds the queue for a person, nothing runs.
    await mac.emit(space, 2, {
      kind: 'turn_ended',
      turn: 1,
      outcome: 'stopped',
    });
    await mac.emit(space, 3, { kind: 'status', status: 'idle' });
    const w = await tool(h, 'space_wait', {
      spaces: [space],
      timeout_ms: 2000,
    });
    expect(w.v.settled).toBe(true);
  });

  it('follows the space from verified events: reply, plan, approve', async () => {
    const { h, mac, mcpId } = await setup();
    const { space } = await started(h, mac);
    const host = mac.id!;
    await mac.emit(space, 1, {
      kind: 'started',
      host_device: host,
      origin_device: mcpId(),
      project_id: 'p1',
      project_name: 'theodore',
      name: 'Fix',
      branch: 'fix-bug',
      mode: 'plan',
      depth: 0,
    });
    await mac.emit(space, 2, { kind: 'status', status: 'running' });
    await mac.emit(space, 3, {
      kind: 'reply',
      turn: 1,
      text: 'Here is the plan',
    });
    await mac.emit(space, 4, {
      kind: 'mirror',
      model: 'space',
      id: space,
      data: {
        id: space,
        status: 'idle',
        turn_log: [{ message: 'm', reply: 'r', plan: '1. do it' }],
        build_mode: 'edit',
      },
    });
    await mac.emit(space, 5, { kind: 'status', status: 'idle' });

    const w = await tool(h, 'space_wait', {
      spaces: [space],
      timeout_ms: 2000,
    });
    expect(w.v).toEqual({
      settled: true,
      spaces: [
        {
          space,
          status: 'idle',
          question: false,
          plan: true,
          waiting_for: null,
          error: null,
        },
      ],
    });
    const r = await tool(h, 'space_read', { space });
    expect(r.v).toMatchObject({
      status: 'idle',
      last_reply: 'Here is the plan',
      plan: '1. do it',
      approve_mode: 'edit',
      last_seq: 5,
    });
    expect(r.v.lines.map((l) => l.kind)).toEqual([
      'started',
      'status',
      'reply',
      'status',
    ]);

    // Approve: an Edit send the computer may refuse (no yes from a person).
    const p = tool(h, 'plan_approve', { space });
    const { body } = await nextRequest(mac);
    expect(body.op).toMatchObject({
      op: 'send',
      text: APPROVED_TEXT,
      mode: 'edit',
    });
    await mac.reply(body.req_id, {
      outcome: 'err',
      code: 'fleet.denied',
      message: 'free text that never reaches the model',
    });
    const denied = await p;
    expect(denied.error).toBe(true);
    expect(denied.v.error.code).toBe('fleet.denied');
    expect(JSON.stringify(denied.v)).not.toContain('free text');
    expect((await tool(h, 'space_read', { space })).v.error).toBe(
      'fleet.denied',
    );
  });

  it('answers a question by its ask id', async () => {
    const { h, mac } = await setup();
    const { space } = await started(h, mac);
    await mac.emit(space, 1, {
      kind: 'question',
      ask_id: 'ask_1',
      questions: [{ question: 'Which?', options: ['A', 'B'], multi: false }],
    });
    await mac.emit(space, 2, { kind: 'status', status: 'waiting' });
    const r = await tool(h, 'space_read', { space });
    expect(r.v.question).toEqual({
      ask: 'ask_1',
      questions: [{ question: 'Which?', options: ['A', 'B'], multi: false }],
    });
    const two = await tool(h, 'ask_answer', {
      space,
      ask: 'ask_1',
      answer: ['A', 'B'],
    });
    expect(two.v.error.code).toBe('mcp.invalid');
    const p = tool(h, 'ask_answer', { space, ask: 'ask_1', answer: 'A' });
    const { req, body } = await nextRequest(mac);
    expect(body.op).toEqual({
      op: 'answer',
      space,
      ask_id: 'ask_1',
      answers: [['A']],
    });
    await mac.send({
      type: 'claim',
      req_id: body.req_id,
      generation: req.generation,
    });
    await mac.reply(body.req_id, { outcome: 'ok', value: null });
    expect((await p).v.result).toBe('ok');
    expect((await tool(h, 'space_read', { space })).v.question).toBeNull();
  });

  it('shows an Edit start waiting for a person, up to 5 min', async () => {
    const { h, mac } = await setup({ replyWaitMs: 30 });
    const s = await tool(h, 'space_start', {
      device: mac.id,
      project: 'p1',
      goal: 'edit it',
      mode: 'edit',
    });
    expect(s.v.result).toBe('pending');
    expect(s.v.waiting_for).toBe('waiting for approval on mac');
    const space = String(s.v.space.space);
    const w = await tool(h, 'space_wait', { spaces: [space], timeout_ms: 50 });
    expect(w.v.settled).toBe(true);
    expect(w.v.spaces[0].waiting_for).toBe('waiting for approval on mac');

    // The person allows after 3 min: past the usual 2 min, still pending.
    const { req, body } = await nextRequest(mac);
    await mac.send({
      type: 'claim',
      req_id: body.req_id,
      generation: req.generation,
    });
    await h.tick(3 * 60_000);
    await mac.reply(body.req_id, {
      outcome: 'ok',
      value: { space, name: 'Edit', branch: 'b' },
    });
    const r = await tool(h, 'space_read', { space });
    expect(r.v).toMatchObject({
      status: 'running',
      waiting_for: null,
      error: null,
    });
  });

  it('hears fleet.offline only after the 5 min window', async () => {
    const { h, mac } = await setup({ replyWaitMs: 30 });
    const s = await tool(h, 'space_start', {
      device: mac.id,
      project: 'p1',
      goal: 'edit it',
      mode: 'edit',
    });
    const space = String(s.v.space.space);
    const { req, body } = await nextRequest(mac);
    await mac.send({
      type: 'claim',
      req_id: body.req_id,
      generation: req.generation,
    });
    await h.tick(4 * 60_000);
    expect((await tool(h, 'space_read', { space })).v.status).toBe('starting');
    await h.tick(61_000);
    const r = await tool(h, 'space_read', { space });
    expect(r.v).toMatchObject({
      status: 'failed',
      error: 'fleet.offline',
      waiting_for: null,
    });
  });

  it('drops events that do not verify against the pin', async () => {
    const { h, mac } = await setup();
    const { space } = await started(h, mac);
    const other = await h.device('user_1', 'impostor');
    const body: SpaceEventBody = {
      space,
      seq: 1,
      host_device: mac.id!,
      event: { kind: 'reply', turn: 1, text: 'forged' },
    };
    const forged = await other.seal('event', body, mac.id!);
    h.mcp!.store.addFrame(
      'user_1',
      JSON.stringify({ type: 'space_event', envelope: forged }),
    );
    const r = await tool(h, 'space_read', { space });
    expect(r.v.last_reply).toBeNull();
    expect(r.v.last_seq).toBe(0);
  });

  it('passes the cloud refusal as a code: an older computer can’t see it', async () => {
    const h = new Harness(undefined, { mcp: true, replyWaitMs: 2000 });
    const old = await h.device('user_1', 'old');
    old.protocol = 4;
    await old.connect();
    await tool(h, 'device_trust', {
      device: old.id,
      fingerprint: await fingerprint(old.publicKey),
    });
    const s = await tool(h, 'space_start', {
      device: old.id,
      project: 'p1',
      goal: 'x',
      mode: 'ask',
    });
    expect(s.error).toBe(true);
    expect(s.v.error.code).toBe('fleet.upgrade_required');
    expect(old.take('request')).toEqual([]);
    expect((await tool(h, 'spaces_list')).v.spaces[0].status).toBe('failed');
  });

  it('goes offline when unused and back on the next call', async () => {
    const { h, mac } = await setup();
    await h.tick(ONLINE_MS + 61_000);
    expect(mcpDevice(h).online).toBe(false);
    const listed = mac.take('devices').at(-1)!.devices;
    expect(listed.find((d) => d.info.kind === 'mcp')?.online).toBe(false);
    const s = await tool(h, 'theodore_status');
    expect(s.error).toBe(false);
    expect(mcpDevice(h).online).toBe(true);
    // Same device, same id: the computer's trust still holds.
    expect(s.v.device.id).toBe(mcpDevice(h).device_id);
  });

  it('keeps tool arguments to their shapes', async () => {
    const { h } = await setup();
    expect((await tool(h, 'space_read', { space: 'nope' })).v.error.code).toBe(
      'mcp.invalid',
    );
    expect(
      (await tool(h, 'space_read', { space: `rs_${'0'.repeat(32)}` })).v.error
        .code,
    ).toBe('mcp.unknown_space');
    expect(
      (
        await tool(h, 'space_start', {
          device: 'dev_x',
          project: 'p1',
          goal: 'x',
          mode: 'ask',
        })
      ).v.error.code,
    ).toBe('mcp.invalid');
  });
});

describe('the mcp kind on the wire', () => {
  it('is never accepted in a socket hello or announce', async () => {
    const h = new Harness();
    const fake = await h.device('user_1', 'fake');
    fake.infoOver = { kind: 'mcp' };
    await expect(fake.connect()).rejects.toThrow(/fleet.bad_message/);
    expect(fake.conn.open).toBe(false);

    const mac = await h.device('user_1', 'mac');
    await mac.connect();
    mac.clear();
    await mac.send({
      type: 'announce',
      info: {
        name: 'mac',
        os: 'macos',
        kind: 'mcp',
        app_version: '1',
        projects: [],
        accepts_remote: false,
        max_mode: 'ask',
      },
    });
    expect(mac.take('error').map((e) => e.code)).toEqual(['fleet.bad_message']);
  });

  it('is hidden from protocols below 5', async () => {
    const h = new Harness(undefined, { mcp: true });
    const p3 = await h.device('user_1', 'p3');
    p3.protocol = 3;
    const p4 = await h.device('user_1', 'p4');
    p4.protocol = 4;
    const p5 = await h.device('user_1', 'p5');
    for (const d of [p3, p4, p5]) await d.connect();
    await tool(h, 'theodore_status');
    const kinds = (d: Device) =>
      d
        .take('devices')
        .at(-1)!
        .devices.map((x) => x.info.kind);
    expect(kinds(p3)).not.toContain('mcp');
    expect(kinds(p4)).not.toContain('mcp');
    expect(kinds(p5)).toContain('mcp');
  });

  it('can’t be used as the origin of a one-shot HTTP request', async () => {
    const { h, mac } = await setup();
    const dev = mcpDevice(h);
    const out = await h.hub.requestOverHttp(
      { userId: 'user_1', orgId: 'org_1', expMs: h.now + 60_000 },
      dev.device_id,
      { device_id: dev.device_id, body: '{}', signature: 'AAAA' },
    );
    expect(out).toMatchObject({
      accepted: false,
      refused: { code: 'fleet.not_yours' },
    });
    expect(mac.take('request')).toEqual([]);
  });

  it('signs requests the computer can check', async () => {
    const { h, mac } = await setup();
    const p = tool(h, 'space_start', {
      device: mac.id,
      project: 'p1',
      goal: 'g',
      mode: 'ask',
    });
    const { req } = await nextRequest(mac);
    expect(
      await verifyEnvelope(mcpDevice(h).public_key, req.envelope, 'request'),
    ).toBe(true);
    const body = JSON.parse(req.envelope.body) as RemoteRequest;
    await mac.reply(body.req_id, {
      outcome: 'err',
      code: 'fleet.mode_not_allowed',
      message: 'm',
    });
    expect((await p).v.error.code).toBe('fleet.mode_not_allowed');
  });
});
