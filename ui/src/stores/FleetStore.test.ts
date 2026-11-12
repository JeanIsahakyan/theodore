/** What each `fleet_*` ephemeral does to the store, and how it loads. */
import { beforeEach, describe, expect, it } from 'vitest';
import { setTransport } from '../core/transport';
import { FakeTransport } from '../test/fakeTransport';
import {
  device,
  question,
  remoteSpace,
  status,
  thisDevice,
} from '../test/fleet';
import { FleetStore, LINE_LIMIT, mergeLines } from './FleetStore';
import { RootStore } from './RootStore';

let transport: FakeTransport;
let fleet: FleetStore;

beforeEach(() => {
  transport = new FakeTransport();
  setTransport(transport);
  fleet = new FleetStore();
});

describe('mergeLines', () => {
  const l = (seq: number, text = String(seq)) => ({
    seq,
    kind: 'reply' as const,
    text,
  });

  it('orders by seq and replaces a line seen twice', () => {
    expect(mergeLines([l(3), l(1)], [l(2), l(3, 'again')])).toEqual([
      l(1),
      l(2),
      l(3, 'again'),
    ]);
  });

  it('keeps only the newest ones', () => {
    const many = Array.from({ length: LINE_LIMIT + 5 }, (_, i) => l(i + 1));
    const kept = mergeLines([], many);
    expect(kept).toHaveLength(LINE_LIMIT);
    expect(kept[0]!.seq).toBe(6);
  });
});

describe('ephemerals', () => {
  it('fleet_status replaces the status', () => {
    expect(fleet.handle({ type: 'fleet_status', status: status() })).toBe(true);
    expect(fleet.available).toBe(true);
    expect(fleet.thisDevice?.name).toBe('Laptop');
    fleet.handle({
      type: 'fleet_status',
      status: status({ available: false }),
    });
    expect(fleet.available).toBe(false);
    expect(fleet.enabled).toBe(false);
  });

  it('fleet_space adds, then updates, a space', () => {
    fleet.handle({ type: 'fleet_space', space: remoteSpace() });
    fleet.handle({
      type: 'fleet_space',
      space: remoteSpace({ status: 'running', last_reply: 'on it' }),
    });
    expect(fleet.spaceList).toHaveLength(1);
    expect(fleet.spaces.get('rs_1')?.status).toBe('running');
    expect(fleet.spaces.get('rs_1')?.last_reply).toBe('on it');
  });

  it('lists waiting spaces first, then running ones', () => {
    fleet.handle({ type: 'fleet_space', space: remoteSpace({ space: 'a' }) });
    fleet.handle({
      type: 'fleet_space',
      space: remoteSpace({ space: 'b', status: 'running' }),
    });
    fleet.handle({
      type: 'fleet_space',
      space: remoteSpace({ space: 'c', status: 'waiting' }),
    });
    expect(fleet.spaceList.map((s) => s.space)).toEqual(['c', 'b', 'a']);
  });

  it('fleet_space_line appends in seq order, without doubles', () => {
    const line = (seq: number) => ({
      type: 'fleet_space_line' as const,
      space: 'rs_1',
      line: { seq, kind: 'reply' as const, text: `t${seq}` },
    });
    fleet.handle(line(2));
    fleet.handle(line(1));
    fleet.handle(line(2));
    expect(fleet.lines.get('rs_1')?.map((x) => x.seq)).toEqual([1, 2]);
  });

  it('fleet_ask holds a routed question until fleet_ask_dismissed', () => {
    fleet.handle({ type: 'fleet_ask', question: question() });
    expect(fleet.askList.map((q) => q.ask_id)).toEqual(['ask1']);
    fleet.handle({ type: 'fleet_ask_dismissed', ask_id: 'ask1' });
    expect(fleet.askList).toEqual([]);
  });

  it('fleet_ask_dismissed also clears the question on its space', () => {
    fleet.handle({
      type: 'fleet_space',
      space: remoteSpace({ status: 'waiting', question: question() }),
    });
    expect(fleet.questionOf('rs_1')?.ask_id).toBe('ask1');
    fleet.handle({ type: 'fleet_ask_dismissed', ask_id: 'ask1' });
    expect(fleet.questionOf('rs_1')).toBeNull();
    expect(fleet.spaces.get('rs_1')?.question).toBeNull();
  });

  it('fleet_trust_needed adds a notice, one per device', () => {
    const request = {
      device_id: 'd2',
      device_name: 'Studio Mac',
      fingerprint: 'a1b2',
    };
    fleet.handle({ type: 'fleet_trust_needed', request });
    fleet.handle({ type: 'fleet_trust_needed', request });
    expect(fleet.trustNeededList).toEqual([request]);
  });

  it('a status that lists the device as trusted clears its notice', () => {
    fleet.handle({
      type: 'fleet_trust_needed',
      request: { device_id: 'd2', device_name: 'x', fingerprint: 'f' },
    });
    fleet.handle({
      type: 'fleet_status',
      status: status({
        devices: [thisDevice(), device({ trusted: true })],
      }),
    });
    expect(fleet.trustNeededList).toEqual([]);
  });

  it('ignores every other event', () => {
    expect(fleet.handle({ type: 'toast', level: 'info', text: 'x' })).toBe(
      false,
    );
  });
});

describe('loading', () => {
  it('reads the status and the spaces', async () => {
    transport.onCall('fleet_status', () => status());
    transport.onCall('fleet_spaces', () => [remoteSpace()]);
    await fleet.load();
    expect(fleet.available).toBe(true);
    expect(fleet.spaces.size).toBe(1);
  });

  it('reads no spaces where there is no fleet', async () => {
    transport.onCall('fleet_status', () => status({ available: false }));
    await fleet.load();
    expect(fleet.available).toBe(false);
    expect(transport.calls.map((c) => c.cmd)).toEqual(['fleet_status']);
  });

  it('stays hidden when the status cannot be read', async () => {
    await fleet.load();
    expect(fleet.status).toBeNull();
    expect(fleet.available).toBe(false);
  });

  it("loads a space's lines after the last one held, merged with live ones", async () => {
    fleet.handle({
      type: 'fleet_space_line',
      space: 'rs_1',
      line: { seq: 7, kind: 'reply', text: 'live' },
    });
    transport.onCall('fleet_space_lines', () => [
      { seq: 5, kind: 'turn', text: 'old' },
      { seq: 6, kind: 'reply', text: 'older' },
    ]);
    await fleet.loadLines('rs_1');
    expect(transport.calls[0]!.args).toEqual({ space: 'rs_1', since: 7 });
    expect(fleet.lines.get('rs_1')?.map((x) => x.seq)).toEqual([5, 6, 7]);
  });

  it('first open asks from the start', async () => {
    transport.onCall('fleet_space_lines', () => []);
    await fleet.loadLines('rs_9');
    expect(transport.calls[0]!.args).toEqual({ space: 'rs_9', since: 0 });
  });
});

describe('commands', () => {
  it('trusting takes the new status and drops the notice', async () => {
    fleet.handle({
      type: 'fleet_trust_needed',
      request: { device_id: 'd2', device_name: 'x', fingerprint: 'f' },
    });
    transport.onCall('fleet_trust_device', () =>
      status({ devices: [thisDevice(), device({ trusted: true })] }),
    );
    await fleet.trust('d2', true);
    expect(transport.calls[0]!.args).toEqual({
      req: { device_id: 'd2', trusted: true },
    });
    expect(fleet.trustNeededList).toEqual([]);
    expect(fleet.device('d2')?.trusted).toBe(true);
  });

  it('starting lists the new space at once', async () => {
    transport.onCall('fleet_start_space', () =>
      remoteSpace({ status: 'starting' }),
    );
    const s = await fleet.start({
      device_id: 'd2',
      project_id: 'p1',
      goal: 'fix it',
      mode: 'edit',
    });
    expect(s.space).toBe('rs_1');
    expect(fleet.spaces.get('rs_1')?.status).toBe('starting');
  });

  it('answering sends the shape the core wants and drops the routed card', async () => {
    const q = question();
    fleet.handle({ type: 'fleet_ask', question: q });
    transport.onCall('fleet_answer', () => null);
    await fleet.answer(q, [['sqlite']]);
    expect(transport.calls[0]).toEqual({
      cmd: 'fleet_answer',
      args: { req: { space: 'rs_1', ask_id: 'ask1', answers: [['sqlite']] } },
    });
    expect(fleet.askList).toEqual([]);
  });

  it('a refused answer keeps the card', async () => {
    const q = question();
    fleet.handle({ type: 'fleet_ask', question: q });
    transport.onCall('fleet_answer', () => {
      throw { code: 'fleet.offline', message: 'offline' };
    });
    await expect(fleet.answer(q, [['sqlite']])).rejects.toBeTruthy();
    expect(fleet.askList).toHaveLength(1);
  });
});

describe('RootStore wiring', () => {
  it('routes fleet ephemerals to the fleet store and loads it on start', async () => {
    transport.onCall('fleet_status', () => status());
    transport.onCall('fleet_spaces', () => []);
    transport.onCall('account_status', () => null);
    const store = new RootStore();
    await store.start().catch(() => {});
    transport.emit('ephemeral', { type: 'fleet_ask', question: question() });
    expect(store.fleet.askList).toHaveLength(1);
    transport.emit('ephemeral', {
      type: 'fleet_ask_dismissed',
      ask_id: 'ask1',
    });
    expect(store.fleet.askList).toHaveLength(0);
    store.dispose();
  });
});
