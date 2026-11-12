import { describe, expect, it } from 'vitest';
import type { RemoteAsk } from '../src/gen/fleet';
import { Harness, startSpace, type Device } from './fleet-harness';

// mac1 started rs_1 on mac2 (the host); mac3 is a third device.
async function setup() {
  const h = new Harness();
  const mac1 = await h.device('user_1', 'mac1');
  const mac2 = await h.device('user_1', 'mac2');
  const mac3 = await h.device('user_1', 'mac3');
  for (const d of [mac1, mac2, mac3]) await d.connect();
  await startSpace(mac1, mac2, 'rs_1');
  for (const d of [mac1, mac2, mac3]) d.clear();
  const ask: RemoteAsk = {
    ask_id: 'ask_1',
    space: 'rs_1',
    host_device: mac2.id!,
    from: 'mac2 · S',
    questions: [{ question: 'Which?', options: ['a', 'b'], multi: false }],
  };
  const raise = () => mac2.send({ type: 'ask', ask });
  const active = (d: Device, idle_ms = 1_000) =>
    d.send({ type: 'presence', focused: true, locked: false, idle_ms });
  return { h, mac1, mac2, mac3, ask, raise, active };
}

const via = (d: Device) => d.take('ask').map((a) => a.via);
const dismissed = (d: Device) => d.take('dismiss').map((x) => x.reason);

describe('fleet questions', () => {
  it('go to the active device', async () => {
    const { mac1, mac3, raise, active } = await setup();
    await active(mac3);
    await raise();
    expect(via(mac3)).toEqual(['active']);
    expect(via(mac1)).toEqual([]);
  });

  it('skip a locked, unfocused or idle device for the origin', async () => {
    const { h, mac1, mac3, raise, active } = await setup();
    await mac3.send({
      type: 'presence',
      focused: true,
      locked: true,
      idle_ms: 0,
    });
    await active(mac1, 30_000);
    h.now += 40_000; // mac1's last input is now 70 s old
    await raise();
    expect(via(mac1)).toEqual(['origin']);
    expect(via(mac3)).toEqual([]);
  });

  it('go to everyone when nobody is active and the origin is away', async () => {
    const { mac1, mac2, mac3, raise } = await setup();
    await mac1.disconnect();
    await raise();
    expect(via(mac3)).toEqual(['escalated']);
    expect(via(mac2)).toEqual([]); // the host shows its own card
  });

  it('escalate to everyone after 20 s', async () => {
    const { h, mac1, mac3, raise } = await setup();
    await raise();
    expect(via(mac1)).toEqual(['origin']);
    await h.tick(19_000);
    expect(via(mac3)).toEqual([]);
    await h.tick(2_000);
    expect(via(mac3)).toEqual(['escalated']);
    expect(via(mac1)).toEqual([]); // already showing it
  });

  it('follow you to the device you moved to', async () => {
    const { mac1, mac3, raise, active } = await setup();
    await active(mac3);
    await raise();
    via(mac3);
    await mac3.send({
      type: 'presence',
      focused: false,
      locked: false,
      idle_ms: 0,
    });
    await active(mac1);
    expect(dismissed(mac3)).toEqual(['moved']);
    expect(via(mac1)).toEqual(['moved']);
  });

  it('leave other devices when you move to the host', async () => {
    const { mac2, mac3, raise, active } = await setup();
    await active(mac3);
    await raise();
    await mac3.send({
      type: 'presence',
      focused: false,
      locked: false,
      idle_ms: 0,
    });
    await active(mac2);
    expect(dismissed(mac3)).toEqual(['moved']);
    expect(via(mac2)).toEqual([]);
  });

  it('are dismissed everywhere when the host resolves them', async () => {
    const { h, mac1, mac2, mac3, raise } = await setup();
    await raise();
    await h.tick(21_000);
    await mac2.send({ type: 'ask_resolved', ask_id: 'ask_1' });
    expect(dismissed(mac1)).toEqual(['resolved']);
    expect(dismissed(mac3)).toEqual(['resolved']);
    // Gone: no more escalation or re-show.
    await mac3.disconnect();
    await mac3.connect();
    expect(via(mac3)).toEqual([]);
  });

  it('are dismissed on the others when answered on one', async () => {
    const { h, mac1, mac2, mac3, raise } = await setup();
    await raise();
    await h.tick(21_000);
    await mac3.request(mac2.id!, {
      op: 'answer',
      space: 'rs_1',
      ask_id: 'ask_1',
      answers: [['a']],
    });
    expect(dismissed(mac1)).toEqual(['answered_elsewhere']);
    expect(dismissed(mac3)).toEqual([]);
    expect(mac2.take('request')).toHaveLength(1);
  });

  it('are shown again on reconnect', async () => {
    const { mac1, raise } = await setup();
    await raise();
    expect(via(mac1)).toEqual(['origin']);
    await mac1.disconnect();
    await mac1.connect();
    expect(via(mac1)).toEqual(['origin']);
  });

  it('come only from the space’s host', async () => {
    const { mac1, ask } = await setup();
    await mac1.send({ type: 'ask', ask: { ...ask, host_device: mac1.id! } });
    await mac1.send({ type: 'ask', ask });
    expect(mac1.take('error').map((e) => e.code)).toEqual([
      'fleet.not_yours',
      'fleet.not_yours',
    ]);
  });

  it('resolve only from the host', async () => {
    const { mac1, mac3, raise } = await setup();
    await raise();
    await mac3.send({ type: 'ask_resolved', ask_id: 'ask_1' });
    expect(mac3.take('error')[0]?.code).toBe('fleet.not_yours');
    expect(dismissed(mac1)).toEqual([]);
  });
});
