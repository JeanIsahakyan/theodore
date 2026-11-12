import { describe, expect, it } from 'vitest';
import { Harness, startOp, startSpace, type Device } from './fleet-harness';

async function pair(h = new Harness()) {
  const mac1 = await h.device('user_1', 'mac1');
  const mac2 = await h.device('user_1', 'mac2');
  await mac1.connect();
  await mac2.connect();
  mac1.clear();
  mac2.clear();
  return { h, mac1, mac2 };
}

const errCode = (d: Device) =>
  d
    .take('reply')
    .map((r) => (r.outcome.outcome === 'err' ? r.outcome.code : 'ok'));

describe('fleet routing', () => {
  it('forwards the envelope unchanged with the target’s generation', async () => {
    const { mac1, mac2 } = await pair();
    const { envelope } = await mac1.request(mac2.id!, startOp('rs_1'));
    expect(mac2.take('request')).toEqual([
      { type: 'request', envelope, generation: mac2.generation },
    ]);
  });

  it('routes the claim, the reply, and records the space', async () => {
    const { mac1, mac2 } = await pair();
    const { reqId } = await mac1.request(mac2.id!, startOp('rs_1'));
    const [req] = mac2.take('request');
    await mac2.send({
      type: 'claim',
      req_id: reqId,
      generation: req!.generation,
    });
    expect(mac2.take('claim_result')).toEqual([
      { type: 'claim_result', req_id: reqId, claimed: true, rejection: null },
    ]);
    const outcome = {
      outcome: 'ok' as const,
      value: { space: 'rs_1', name: 'S', branch: 'b' },
    };
    await mac2.send({ type: 'reply', req_id: reqId, outcome });
    expect(mac1.take('reply')).toEqual([
      { type: 'reply', req_id: reqId, outcome },
    ]);
    // Recorded: mac2 may now send its events.
    await mac2.emit('rs_1', 1, { kind: 'status', status: 'running' });
    expect(mac2.take('error')).toEqual([]);
  });

  it('refuses an envelope not from the sending device', async () => {
    const { mac1, mac2 } = await pair();
    const envelope = await mac1.envelope(mac2.id!, startOp('rs_1'));
    // mac2 replays mac1's signed request as its own.
    await mac2.send({ type: 'request', envelope });
    expect(errCode(mac2)).toEqual(['fleet.not_yours']);
    expect(mac1.take('request')).toEqual([]);
  });

  it('refuses another user’s device and an unknown one alike', async () => {
    const { h, mac1 } = await pair();
    const theirs = await h.device('user_2', 'theirs');
    await theirs.connect();
    theirs.clear();
    await mac1.request(theirs.id!, startOp('rs_1'));
    await mac1.request('dev_nope', startOp('rs_2'));
    expect(errCode(mac1)).toEqual(['fleet.not_yours', 'fleet.not_yours']);
    expect(theirs.take('request')).toEqual([]);
  });

  it('answers fleet.offline after the 10 s grace', async () => {
    const { h, mac1, mac2 } = await pair();
    await mac2.disconnect();
    await mac1.request(mac2.id!, startOp('rs_1'));
    await h.tick(9_000);
    expect(errCode(mac1)).toEqual([]);
    await h.tick(1_500);
    expect(errCode(mac1)).toEqual(['fleet.offline']);
  });

  it('delivers to a target that comes back within the grace', async () => {
    const { h, mac1, mac2 } = await pair();
    await mac2.disconnect();
    const { envelope } = await mac1.request(mac2.id!, startOp('rs_1'));
    await h.tick(5_000);
    await mac2.connect();
    expect(mac2.take('request')).toEqual([
      { type: 'request', envelope, generation: mac2.generation },
    ]);
    await h.tick(10_000);
    expect(errCode(mac1)).toEqual([]);
  });

  it('re-sends an unclaimed request on reconnect, fencing the old generation', async () => {
    const { mac1, mac2 } = await pair();
    const { reqId } = await mac1.request(mac2.id!, startOp('rs_1'));
    const [first] = mac2.take('request');
    await mac2.disconnect();
    await mac2.connect();
    const [again] = mac2.take('request');
    expect(again!.generation).toBe(first!.generation + 1);
    await mac2.send({
      type: 'claim',
      req_id: reqId,
      generation: first!.generation,
    });
    await mac2.send({
      type: 'claim',
      req_id: reqId,
      generation: again!.generation,
    });
    expect(
      mac2.take('claim_result').map((c) => c.rejection ?? 'claimed'),
    ).toEqual(['stale_generation', 'claimed']);
  });

  it('rejects claims: not_pending, wrong_target, already_claimed', async () => {
    const { h, mac1, mac2 } = await pair();
    const mac3 = await h.device('user_1', 'mac3');
    await mac3.connect();
    const { reqId } = await mac1.request(mac2.id!, startOp('rs_1'));
    const g = mac2.generation;
    await mac2.send({ type: 'claim', req_id: 'req_unknown', generation: g });
    await mac3.send({
      type: 'claim',
      req_id: reqId,
      generation: mac3.generation,
    });
    await mac2.send({ type: 'claim', req_id: reqId, generation: g });
    await mac2.send({ type: 'claim', req_id: reqId, generation: g });
    const results = [
      ...mac2.take('claim_result'),
      ...mac3.take('claim_result'),
    ];
    expect(results.map((c) => c.rejection ?? 'claimed')).toEqual([
      'not_pending',
      'claimed',
      'already_claimed',
      'wrong_target',
    ]);
  });

  it('hides another user’s request from a claim', async () => {
    const { h, mac1, mac2 } = await pair();
    const theirs = await h.device('user_2', 'theirs');
    await theirs.connect();
    const { reqId } = await mac1.request(mac2.id!, startOp('rs_1'));
    await theirs.send({
      type: 'claim',
      req_id: reqId,
      generation: theirs.generation,
    });
    expect(theirs.take('claim_result')[0]?.rejection).toBe('not_pending');
  });

  it('takes a reply only from the claimed target; an err needs no claim', async () => {
    const { h, mac1, mac2 } = await pair();
    const mac3 = await h.device('user_1', 'mac3');
    await mac3.connect();
    const ok = { outcome: 'ok' as const, value: null };
    const { reqId } = await mac1.request(mac2.id!, startOp('rs_1'));
    await mac2.send({ type: 'reply', req_id: reqId, outcome: ok });
    expect(mac2.take('error')[0]?.code).toBe('fleet.bad_message');
    await mac3.send({ type: 'reply', req_id: reqId, outcome: ok });
    expect(mac3.take('error')[0]?.code).toBe('fleet.not_yours');
    expect(errCode(mac1)).toEqual([]);
    await mac2.send({
      type: 'reply',
      req_id: reqId,
      outcome: {
        outcome: 'err',
        code: 'fleet.untrusted_device',
        message: 'trust?',
      },
    });
    expect(errCode(mac1)).toEqual(['fleet.untrusted_device']);
  });

  it('accepts a claimed request’s reply right after a reconnect (outbox)', async () => {
    const { mac1, mac2 } = await pair();
    const { reqId } = await mac1.request(mac2.id!, startOp('rs_1'));
    await mac2.send({
      type: 'claim',
      req_id: reqId,
      generation: mac2.generation,
    });
    await mac2.disconnect();
    await mac2.connect();
    // Claimed already: not re-sent.
    expect(mac2.take('request')).toEqual([]);
    await mac2.send({
      type: 'reply',
      req_id: reqId,
      outcome: {
        outcome: 'ok',
        value: { space: 'rs_1', name: 'S', branch: 'b' },
      },
    });
    expect(errCode(mac1)).toEqual(['ok']);
  });

  it('expires a pending request after 2 min', async () => {
    const { h, mac1, mac2 } = await pair();
    const { reqId } = await mac1.request(mac2.id!, startOp('rs_1'));
    await mac2.send({
      type: 'claim',
      req_id: reqId,
      generation: mac2.generation,
    });
    await h.tick(119_000);
    expect(errCode(mac1)).toEqual([]);
    await h.tick(2_000);
    expect(errCode(mac1)).toEqual(['fleet.offline']);
    // Only the access-token deadlines are left to wake for.
    expect(h.scheduled.at(-1)).toBeGreaterThan(h.now + 60_000);
  });

  it('holds a reply for an origin that went away', async () => {
    const { mac1, mac2 } = await pair();
    const { reqId } = await mac1.request(mac2.id!, startOp('rs_1'));
    await mac2.send({
      type: 'claim',
      req_id: reqId,
      generation: mac2.generation,
    });
    await mac1.disconnect();
    await mac2.send({
      type: 'reply',
      req_id: reqId,
      outcome: { outcome: 'ok', value: null },
    });
    await mac1.connect();
    expect(errCode(mac1)).toEqual(['ok']);
  });

  it('refuses a request to the sending device itself', async () => {
    const { mac1 } = await pair();
    await mac1.request(mac1.id!, startOp('rs_1'));
    expect(errCode(mac1)).toEqual(['fleet.invalid']);
    expect(mac1.take('request')).toEqual([]);
  });

  it('refuses a duplicate req_id', async () => {
    const { mac1, mac2 } = await pair();
    await mac1.request(mac2.id!, startOp('rs_1'), 'req_same');
    await mac1.request(mac2.id!, startOp('rs_2'), 'req_same');
    expect(mac1.take('error')[0]?.code).toBe('fleet.bad_message');
    expect(mac2.take('request')).toHaveLength(1);
  });

  it('refuses a body that isn’t a request', async () => {
    const { mac1, mac2 } = await pair();
    await mac1.send({
      type: 'request',
      envelope: { device_id: mac1.id!, body: '{"req_id":', signature: 'x' },
    });
    expect(mac1.take('error')[0]?.code).toBe('fleet.bad_message');
    expect(mac2.take('request')).toEqual([]);
  });
});

describe('fleet depth and children', () => {
  it('refuses deeper than MAX_DEPTH', async () => {
    const { mac1, mac2 } = await pair();
    await mac1.request(mac2.id!, startOp('rs_x', { depth: 3 }));
    expect(errCode(mac1)).toEqual(['fleet.depth']);
    expect(mac2.take('request')).toEqual([]);
  });

  it('wants the parent’s depth + 1', async () => {
    const { mac1, mac2 } = await pair();
    await startSpace(mac1, mac2, 'rs_root');
    await mac2.request(
      mac1.id!,
      startOp('rs_c', { parent: 'rs_root', depth: 2 }),
    );
    expect(errCode(mac2)).toEqual(['fleet.depth']);
    await mac2.request(
      mac1.id!,
      startOp('rs_c', { parent: 'rs_root', depth: 1 }),
    );
    expect(errCode(mac2)).toEqual([]);
    expect(mac1.take('request')).toHaveLength(1);
  });

  it('refuses a sixth child, counting pending starts', async () => {
    const { mac1, mac2 } = await pair();
    await startSpace(mac1, mac2, 'rs_root');
    for (let i = 0; i < 3; i++) {
      await startSpace(mac2, mac1, `rs_c${i}`, { parent: 'rs_root', depth: 1 });
    }
    for (let i = 3; i < 5; i++) {
      await mac2.request(
        mac1.id!,
        startOp(`rs_c${i}`, { parent: 'rs_root', depth: 1 }),
      );
    }
    expect(errCode(mac2)).toEqual([]);
    await mac2.request(
      mac1.id!,
      startOp('rs_c5', { parent: 'rs_root', depth: 1 }),
    );
    expect(errCode(mac2)).toEqual(['fleet.depth']);
  });

  it('refuses another user’s space as parent or target space', async () => {
    const { h, mac1, mac2 } = await pair();
    await startSpace(mac1, mac2, 'rs_mine');
    const a = await h.device('user_2', 'a');
    const b = await h.device('user_2', 'b');
    await a.connect();
    await b.connect();
    a.clear();
    await a.request(b.id!, startOp('rs_c', { parent: 'rs_mine', depth: 1 }));
    await a.request(b.id!, { op: 'stop', space: 'rs_mine' });
    expect(errCode(a)).toEqual(['fleet.not_yours', 'fleet.not_yours']);
  });
});
