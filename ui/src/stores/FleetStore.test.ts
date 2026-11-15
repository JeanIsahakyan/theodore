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
  trustNeeded,
} from '../test/fleet';
import { FleetStore } from './FleetStore';
import { RootStore } from './RootStore';

let transport: FakeTransport;
let fleet: FleetStore;

beforeEach(() => {
  transport = new FakeTransport();
  setTransport(transport);
  fleet = new FleetStore();
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
    expect(fleet.spaces.size).toBe(1);
    expect(fleet.spaces.get('rs_1')?.status).toBe('running');
    expect(fleet.spaces.get('rs_1')?.last_reply).toBe('on it');
  });

  it('fleet_space_line is taken and kept nowhere: the chat is the mirrored row', () => {
    expect(
      fleet.handle({
        type: 'fleet_space_line',
        space: 'rs_1',
        line: { seq: 1, kind: 'reply', text: 'x' },
      }),
    ).toBe(true);
    expect(fleet.spaces.size).toBe(0);
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
    fleet.handle({ type: 'fleet_ask_dismissed', ask_id: 'ask1' });
    expect(fleet.spaces.get('rs_1')?.question).toBeNull();
  });

  it('fleet_trust_needed adds a notice, one per device', () => {
    const request = trustNeeded();
    fleet.handle({ type: 'fleet_trust_needed', request });
    fleet.handle({ type: 'fleet_trust_needed', request });
    expect(fleet.trustNeededList).toEqual([request]);
  });

  it('a status that lists the device as trusted clears its notice', () => {
    fleet.handle({
      type: 'fleet_trust_needed',
      request: trustNeeded(),
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
});

describe('commands', () => {
  it('trusting takes the new status and drops the notice', async () => {
    fleet.handle({
      type: 'fleet_trust_needed',
      request: trustNeeded(),
    });
    transport.onCall('fleet_trust_device', () =>
      status({ devices: [thisDevice(), device({ trusted: true })] }),
    );
    await fleet.trust('d2', 'pk-compared');
    expect(transport.calls[0]!.args).toEqual({
      req: { device_id: 'd2', trusted: true, public_key: 'pk-compared' },
    });
    expect(fleet.trustNeededList).toEqual([]);
    expect(fleet.device('d2')?.trusted).toBe(true);
  });

  it('a trust the core refuses (the key changed) throws and changes nothing', async () => {
    fleet.setStatus(status());
    fleet.handle({ type: 'fleet_trust_needed', request: trustNeeded() });
    transport.queueResult(
      'fleet_trust_device',
      new Error('the key of Studio Mac changed'),
    );
    await expect(fleet.trust('d2', 'pk-old')).rejects.toThrow('key');
    expect(fleet.device('d2')?.trusted).toBe(false);
    expect(fleet.trustNeededList).toHaveLength(1);
  });

  it('untrusting sends no key', async () => {
    transport.onCall('fleet_trust_device', () => status());
    await fleet.untrust('d2');
    expect(transport.calls[0]!.args).toEqual({
      req: { device_id: 'd2', trusted: false, public_key: null },
    });
  });

  it('removing a device takes the new status and drops its notice', async () => {
    fleet.setStatus(status());
    fleet.handle({ type: 'fleet_trust_needed', request: trustNeeded() });
    transport.onCall('fleet_remove_device', () =>
      status({ devices: [thisDevice()] }),
    );
    await fleet.remove('d2');
    expect(transport.calls).toEqual([
      { cmd: 'fleet_remove_device', args: { deviceId: 'd2' } },
    ]);
    expect(fleet.device('d2')).toBeUndefined();
    expect(fleet.trustNeededList).toEqual([]);
  });

  it('delegating sends the device and the switch, and takes the new status', async () => {
    fleet.setStatus(status());
    transport.onCall('fleet_delegate', () =>
      status({
        devices: [
          thisDevice(),
          device({ kind: 'mobile', trusted: true, delegated: true }),
        ],
      }),
    );
    await fleet.delegate('d2', true);
    expect(transport.calls).toEqual([
      { cmd: 'fleet_delegate', args: { deviceId: 'd2', on: true } },
    ]);
    expect(fleet.device('d2')?.delegated).toBe(true);
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
