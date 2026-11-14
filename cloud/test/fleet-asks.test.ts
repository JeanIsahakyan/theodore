import { describe, expect, it } from 'vitest';
import type { RemoteAsk } from '../src/gen/fleet';
import { MAX_ASKS_PER_SPACE, MAX_ASKS_PER_USER } from '../src/fleet/limits';
import { Harness, startSpace, type Device } from './fleet-harness';

// mac1 started rs_1 on mac2 (the host); mac3 is a third device of the same
// user (maybe untrusted: it never sees rs_1's questions).
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
  const raise = () => mac2.raise(ask);
  const active = (d: Device, idle_ms = 1_000) =>
    d.send({ type: 'presence', focused: true, locked: false, idle_ms });
  const away = (d: Device) =>
    d.send({ type: 'presence', focused: false, locked: false, idle_ms: 0 });
  const answer = () =>
    mac1.request(mac2.id!, {
      op: 'answer',
      space: 'rs_1',
      ask_id: 'ask_1',
      answers: [['a']],
    });
  return { h, mac1, mac2, mac3, ask, raise, active, away, answer };
}

const via = (d: Device) => d.take('ask').map((a) => a.via);
const dismissed = (d: Device) => d.take('dismiss').map((x) => x.reason);

describe('fleet questions', () => {
  it('go to the origin when you’re at it, forwarded unchanged', async () => {
    const { mac1, mac3, raise, active } = await setup();
    await active(mac1);
    const envelope = await raise();
    expect(mac1.take('ask')).toEqual([
      { type: 'ask', envelope, via: 'active' },
    ]);
    expect(via(mac3)).toEqual([]);
  });

  it('go to the origin, not to another device you’re at', async () => {
    const { mac1, mac3, raise, active } = await setup();
    await active(mac3);
    await raise();
    expect(via(mac1)).toEqual(['origin']);
    expect(via(mac3)).toEqual([]);
  });

  it('skip a locked, unfocused or idle origin: still the origin', async () => {
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

  it('stay on the host when you’re at the host', async () => {
    const { mac1, mac2, mac3, raise, active } = await setup();
    await active(mac2);
    await raise();
    expect([...via(mac1), ...via(mac2), ...via(mac3)]).toEqual([]);
  });

  it('wait for the origin when it is away, never going to others', async () => {
    const { h, mac1, mac2, mac3, raise } = await setup();
    await mac1.disconnect();
    await raise();
    await h.tick(21_000);
    expect(via(mac3)).toEqual([]);
    expect(via(mac2)).toEqual([]); // the host shows its own card
    await mac1.connect();
    expect(via(mac1)).toEqual(['escalated']);
  });

  it('escalate to the origin only after 20 s', async () => {
    const { h, mac1, mac2, mac3, raise, active } = await setup();
    await active(mac2, 50_000);
    await raise(); // you're at the host: shown there only
    expect(via(mac1)).toEqual([]);
    await h.tick(19_000);
    expect(via(mac1)).toEqual([]);
    await h.tick(2_000);
    expect(via(mac1)).toEqual(['escalated']);
    expect(via(mac3)).toEqual([]);
    expect(via(mac2)).toEqual([]);
  });

  it('follow you from the origin to the host and back', async () => {
    const { mac1, mac2, raise, active, away } = await setup();
    await active(mac1);
    await raise();
    expect(via(mac1)).toEqual(['active']);
    await away(mac1);
    await active(mac2);
    expect(dismissed(mac1)).toEqual(['moved']);
    expect(via(mac2)).toEqual([]);
    await away(mac2);
    await active(mac1);
    expect(via(mac1)).toEqual(['moved']);
  });

  it('aren’t pulled by presence on another device', async () => {
    const { mac1, mac3, raise, active, away } = await setup();
    await active(mac1);
    await raise();
    via(mac1);
    await away(mac1);
    await active(mac3);
    expect(via(mac3)).toEqual([]);
    expect(dismissed(mac1)).toEqual([]);
  });

  it('are dismissed everywhere when the host resolves them', async () => {
    const { h, mac1, mac2, raise } = await setup();
    await raise();
    await h.tick(21_000);
    await mac2.send({ type: 'ask_resolved', ask_id: 'ask_1' });
    expect(dismissed(mac1)).toEqual(['resolved']);
    // Gone: no more escalation or re-show.
    await mac1.disconnect();
    await mac1.connect();
    expect(via(mac1)).toEqual([]);
  });

  it('stay open when the host refuses the answer', async () => {
    const { h, mac1, mac2, raise, answer } = await setup();
    await raise();
    expect(via(mac1)).toEqual(['origin']);
    await h.tick(21_000);
    const { reqId } = await answer();
    await mac2.reply(reqId, {
      outcome: 'err',
      code: 'fleet.untrusted_device',
      message: 'trust?',
    });
    expect(dismissed(mac1)).toEqual([]);
    await mac1.disconnect();
    await mac1.connect();
    expect(via(mac1)).toEqual(['escalated']); // still open
  });

  it('are dismissed elsewhere only after the host’s ok', async () => {
    const { h, mac1, mac2, mac3, raise } = await setup();
    await raise();
    expect(via(mac1)).toEqual(['origin']);
    await h.tick(21_000);
    // mac3 knows the ask id: whether it may answer is the host's call.
    const { reqId } = await mac3.request(mac2.id!, {
      op: 'answer',
      space: 'rs_1',
      ask_id: 'ask_1',
      answers: [['a']],
    });
    expect(dismissed(mac1)).toEqual([]); // routed, not taken yet
    await mac2.send({
      type: 'claim',
      req_id: reqId,
      generation: mac2.generation,
    });
    await mac2.reply(reqId, { outcome: 'ok', value: null });
    expect(dismissed(mac1)).toEqual(['answered_elsewhere']);
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
    await mac1.raise({ ...ask, host_device: mac1.id! });
    await mac1.raise(ask);
    expect(mac1.take('error').map((e) => e.code)).toEqual([
      'fleet.not_yours',
      'fleet.not_yours',
    ]);
  });

  it('must be signed as a question by the host', async () => {
    const { mac1, mac2, ask } = await setup();
    for (const envelope of [
      await mac2.seal('event', ask),
      await mac1.seal('ask', ask, mac2.id!),
    ]) {
      await mac2.send({ type: 'ask', envelope });
    }
    expect(mac2.take('error').map((e) => e.code)).toEqual([
      'fleet.bad_signature',
      'fleet.bad_signature',
    ]);
    expect(via(mac1)).toEqual([]);
  });

  it('resolve only from the host', async () => {
    const { mac1, mac3, raise } = await setup();
    await raise();
    await mac3.send({ type: 'ask_resolved', ask_id: 'ask_1' });
    expect(mac3.take('error')[0]?.code).toBe('fleet.not_yours');
    expect(dismissed(mac1)).toEqual([]);
  });

  it(`hold at most ${MAX_ASKS_PER_SPACE} per space`, async () => {
    const { h, mac2, ask } = await setup();
    for (let i = 0; i <= MAX_ASKS_PER_SPACE; i++) {
      h.now += 25;
      await mac2.raise({ ...ask, ask_id: `ask_${i}` });
    }
    expect(mac2.take('error').map((e) => e.code)).toEqual(['fleet.busy']);
  });

  it(`hold at most ${MAX_ASKS_PER_USER} per user`, async () => {
    const { h, mac1, mac2, ask } = await setup();
    const spaces = Math.ceil(MAX_ASKS_PER_USER / MAX_ASKS_PER_SPACE);
    for (let s = 0; s < spaces; s++) {
      await startSpace(mac1, mac2, `rs_u${s}`);
      for (let i = 0; i < MAX_ASKS_PER_SPACE; i++) {
        h.now += 25;
        await mac2.raise({ ...ask, space: `rs_u${s}`, ask_id: `a_${s}_${i}` });
      }
    }
    expect(mac2.take('error')).toEqual([]);
    await mac2.raise({ ...ask, ask_id: 'one_more' });
    expect(mac2.take('error').map((e) => e.code)).toEqual(['fleet.busy']);
  });
});
