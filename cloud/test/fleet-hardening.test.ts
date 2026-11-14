import { describe, expect, it, vi } from 'vitest';
import { MAX_FRAME_BYTES, RATE_BURST } from '../src/fleet/limits';
import { Harness } from './fleet-harness';

async function one(expMs?: number) {
  const h = new Harness();
  const mac = await h.device();
  await mac.connect({ expMs });
  mac.clear();
  return { h, mac };
}

describe('fleet reauth', () => {
  it('closes a connection whose token expired 60 s ago', async () => {
    const { h, mac } = await one(T(10_000));
    await h.tick(69_000);
    expect(mac.conn.open).toBe(true);
    await h.tick(2_000);
    expect(mac.sent[0]).toMatchObject({ code: 'fleet.unauthorized' });
    expect(mac.conn.closedWith).toEqual({
      code: 4001,
      reason: 'fleet.unauthorized',
    });
  });

  it('keeps a connection that reauths', async () => {
    const { h, mac } = await one(T(10_000));
    h.tokens.set('fresh', {
      userId: 'user_1',
      organizationId: 'org_1',
      expiresAt: (T(0) + 3_600_000) / 1000,
    });
    await mac.send({ type: 'reauth', access_token: 'fresh' });
    await h.tick(120_000);
    expect(mac.conn.open).toBe(true);
  });

  it('answers a refused token with an error and keeps the deadline', async () => {
    const { h, mac } = await one(T(10_000));
    await mac.send({ type: 'reauth', access_token: 'junk' });
    expect(mac.take('error')[0]?.code).toBe('fleet.unauthorized');
    expect(mac.conn.open).toBe(true);
    await h.tick(71_000);
    expect(mac.conn.open).toBe(false);
  });

  it('closes a JWKS outage at the deadline as unavailable, not unauthorized', async () => {
    const { h, mac } = await one(T(10_000));
    h.tokens.set('fresh', {
      userId: 'user_1',
      organizationId: 'org_1',
      expiresAt: (T(0) + 3_600_000) / 1000,
    });
    h.jwksDown = true;
    await mac.send({ type: 'reauth', access_token: 'fresh' });
    // Nothing the device would take as fatal.
    expect(mac.take('error')).toEqual([]);
    expect(mac.conn.open).toBe(true);
    await h.tick(71_000);
    expect(mac.sent.at(-1)).toMatchObject({ code: 'fleet.unavailable' });
    expect(mac.conn.closedWith).toEqual({
      code: 1011,
      reason: 'fleet.unavailable',
    });
  });

  it('a reauth that verifies after an outage keeps the connection', async () => {
    const { h, mac } = await one(T(10_000));
    h.tokens.set('fresh', {
      userId: 'user_1',
      organizationId: 'org_1',
      expiresAt: (T(0) + 3_600_000) / 1000,
    });
    h.jwksDown = true;
    await mac.send({ type: 'reauth', access_token: 'fresh' });
    h.jwksDown = false;
    await mac.send({ type: 'reauth', access_token: 'fresh' });
    await h.tick(120_000);
    expect(mac.conn.open).toBe(true);
  });

  it('a bad token after an outage is fatal again', async () => {
    const { h, mac } = await one(T(10_000));
    h.jwksDown = true;
    await mac.send({ type: 'reauth', access_token: 'junk' });
    h.jwksDown = false;
    await mac.send({ type: 'reauth', access_token: 'junk' });
    expect(mac.take('error')[0]?.code).toBe('fleet.unauthorized');
    await h.tick(71_000);
    expect(mac.conn.closedWith).toEqual({
      code: 4001,
      reason: 'fleet.unauthorized',
    });
  });

  it('closes on a token for another user or org', async () => {
    const { h, mac } = await one();
    h.tokens.set('other_user', { userId: 'user_2', organizationId: 'org_1' });
    await mac.send({ type: 'reauth', access_token: 'other_user' });
    expect(mac.conn.closedWith?.code).toBe(4001);

    const b = await one();
    b.h.tokens.set('other_org', { userId: 'user_1', organizationId: 'org_2' });
    await b.mac.send({ type: 'reauth', access_token: 'other_org' });
    expect(b.mac.sent[0]).toMatchObject({ code: 'fleet.no_org' });
    expect(b.mac.conn.closedWith).toEqual({
      code: 4001,
      reason: 'fleet.no_org',
    });
  });
});

// Token expiries relative to the harness clock's start.
function T(ms: number) {
  return 1_800_000_000_000 + ms;
}

describe('fleet hardening', () => {
  it('closes on a frame over MAX_FRAME_BYTES', async () => {
    const { mac } = await one();
    await mac.send('x'.repeat(MAX_FRAME_BYTES + 1));
    expect(mac.sent[0]).toMatchObject({ code: 'fleet.too_large' });
    expect(mac.conn.closedWith?.code).toBe(1009);
  });

  it('counts bytes, not chars', async () => {
    const { mac } = await one();
    await mac.send('é'.repeat(MAX_FRAME_BYTES / 2 + 1));
    expect(mac.sent[0]).toMatchObject({ code: 'fleet.too_large' });
  });

  it('answers bad JSON, unknown types and binary with an error, staying open', async () => {
    const { mac } = await one();
    await mac.send('{not json');
    await mac.send(JSON.stringify({ type: 'launch_missiles' }));
    await mac.send(JSON.stringify({ type: 'claim', req_id: 7 }));
    await mac.send(new ArrayBuffer(4));
    expect(mac.take('error').map((e) => e.code)).toEqual([
      'fleet.bad_message',
      'fleet.bad_message',
      'fleet.bad_message',
      'fleet.bad_message',
    ]);
    expect(mac.conn.open).toBe(true);
  });

  it('rate-limits a flood, then recovers', async () => {
    const { h, mac } = await one();
    const presence = {
      type: 'presence',
      focused: false,
      locked: false,
      idle_ms: 0,
    } as const;
    for (let i = 0; i < RATE_BURST + 50; i++) await mac.send(presence);
    const errors = mac.take('error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('fleet.rate_limited');
    h.now += 1_000;
    await mac.send({ type: 'subscribe', space: 'rs_none', since: 0 });
    expect(mac.take('error')[0]?.code).toBe('fleet.not_yours');
  });

  it('never logs a token or a body', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { h, mac } = await one();
    h.tokens.set('secret-token', { userId: 'user_2', organizationId: 'org_1' });
    await mac.send({ type: 'reauth', access_token: 'secret-token' });
    const calls = JSON.stringify([...log.mock.calls, ...spy.mock.calls]);
    expect(calls).not.toContain('secret-token');
    log.mockRestore();
    spy.mockRestore();
  });
});
