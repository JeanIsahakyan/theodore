import { describe, expect, it } from 'vitest';
import { verifyAccessToken } from '../src/auth';
import { handle, type Deps } from '../src/index';
import type { RelayBatch } from '../src/telemetry/cloud';
import { Logger, type LogRecord } from '../src/telemetry/log';
import { parseRelay, RELAY } from '../src/telemetry/relay';
import { FakeWorkos } from './fake-workos';
import { API, CLIENT, signer } from './keys';

const NOW = 1_700_000_000_000;
const JWT =
  'eyJhbGciOiJSUzI1NiIsImtpZCI6ImsxIn0.eyJzdWIiOiJ1c2VyXzEiLCJleHAiOjF9.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU';

const resource = {
  'service.name': 'theodore-mobile',
  'service.version': '0.1.30',
  'os.type': 'ios',
  'deployment.environment.name': 'production',
  'service.instance.id': 'inst_1',
};

const rec = (over: Record<string, unknown> = {}) => ({
  ts: NOW - 1000,
  level: 'error',
  msg: 'something broke',
  attrs: { 'error.code': 'ui.uncaught', count: 2, fatal: true },
  ...over,
});

describe('parseRelay', () => {
  const ctx = { nowMs: NOW, region: 'FRA' };

  it('keeps a well-formed batch, adding the relay attributes', () => {
    const out = parseRelay({ records: [rec()], resource }, ctx);
    expect(out.dropped).toBe(0);
    expect(out.service).toBe('theodore-mobile');
    expect(out.resource).toEqual(resource);
    expect(out.records).toEqual([
      {
        ts: NOW - 1000,
        level: 'error',
        msg: 'something broke',
        attrs: {
          'error.code': 'ui.uncaught',
          count: 2,
          fatal: true,
          'theodore.relay': true,
          'cloud.region': 'FRA',
        },
      },
    ]);
  });

  it('refuses no records, too many records, an unknown service', () => {
    const code = (body: Record<string, unknown>) => {
      try {
        parseRelay(body, ctx);
      } catch (e) {
        return (e as { status: number; code: string }).status;
      }
      return 0;
    };
    expect(code({ resource })).toBe(400);
    expect(code({ records: [], resource })).toBe(400);
    expect(code({ records: 'x', resource })).toBe(400);
    expect(
      code({ records: Array(RELAY.records + 1).fill(rec()), resource }),
    ).toBe(400);
    expect(code({ records: [rec()] })).toBe(400);
    expect(
      code({
        records: [rec()],
        resource: { ...resource, 'service.name': 'evil' },
      }),
    ).toBe(400);
    expect(code({ records: Array(RELAY.records).fill(rec()), resource })).toBe(
      0,
    );
  });

  it('drops records with a bad level, msg or shape; clamps a wild ts', () => {
    const out = parseRelay(
      {
        records: [
          rec({ level: 'info' }),
          rec({ level: 'debug' }),
          rec({ msg: 42 }),
          rec({ msg: '' }),
          'nope',
          rec({ ts: 'yesterday' }),
          rec({ ts: NOW + 3_600_000 }),
          rec({ level: 'warn', ts: NOW - 365 * 24 * 3_600_000 }),
        ],
        resource,
      },
      ctx,
    );
    expect(out.dropped).toBe(5);
    expect(out.records.map((r) => r.ts)).toEqual([NOW, NOW, NOW]);
    expect(out.records[2]?.level).toBe('warn');
  });

  it('drops unknown and oversized fields, keeps what fits', () => {
    const attrs: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) attrs[`k${i}`] = i;
    attrs['x'.repeat(65)] = 'too long a key';
    attrs.long = 'v'.repeat(RELAY.valueChars + 1);
    attrs.obj = { a: 1 };
    attrs.arr = [1];
    attrs.nan = Number.NaN;
    attrs.nul = null;
    const out = parseRelay(
      {
        records: [{ ...rec({ attrs }), extra: 'field', stack: 'x' }],
        resource: {
          ...resource,
          extra: 'field',
          'os.type': 7,
          'service.version': 'v'.repeat(300),
        },
        more: true,
      },
      ctx,
    );
    const r = out.records[0]!;
    const keys = Object.keys(r.attrs);
    expect(keys).toHaveLength(RELAY.attrs + 2);
    expect(keys).not.toContain('x'.repeat(65));
    expect(keys).not.toContain('long');
    expect(keys).not.toContain('obj');
    expect(keys).not.toContain('arr');
    expect(keys).not.toContain('nan');
    expect(keys).not.toContain('nul');
    expect('extra' in r).toBe(false);
    expect('stack' in r).toBe(false);
    expect(out.resource).toEqual({
      'service.name': 'theodore-mobile',
      'deployment.environment.name': 'production',
      'service.instance.id': 'inst_1',
    });
  });

  it('cuts a long msg and redacts secrets and emails in texts', () => {
    const out = parseRelay(
      {
        records: [
          rec({
            msg: `Bearer ${JWT} ${'m'.repeat(3000)}`,
            attrs: { who: 'ann@example.test', token: `${JWT}` },
          }),
        ],
        resource: { ...resource, 'service.version': `v ann@example.test` },
      },
      ctx,
    );
    const text = JSON.stringify(out);
    expect(text).not.toContain(JWT);
    expect(text).not.toContain('ann@example.test');
    expect(out.records[0]!.msg.length).toBeLessThan(RELAY.msgChars + 40);
  });

  it('keeps enduser.id only when it is the token’s user', () => {
    const withUser = { ...resource, 'enduser.id': 'user_1' };
    expect(
      parseRelay({ records: [rec()], resource: withUser }, ctx).resource[
        'enduser.id'
      ],
    ).toBe(undefined);
    expect(
      parseRelay(
        { records: [rec()], resource: withUser },
        { ...ctx, userId: 'user_2' },
      ).resource['enduser.id'],
    ).toBe(undefined);
    expect(
      parseRelay(
        { records: [rec()], resource: withUser },
        { ...ctx, userId: 'user_1' },
      ).resource['enduser.id'],
    ).toBe('user_1');
    // A token user that isn't shaped like a WorkOS id isn't passed on either.
    expect(
      parseRelay(
        {
          records: [rec()],
          resource: { ...resource, 'enduser.id': 'ann@example.test' },
        },
        { ...ctx, userId: 'ann@example.test' },
      ).resource['enduser.id'],
    ).toBe(undefined);
  });
});

describe('POST /v1/telemetry/logs', async () => {
  const { keys, sign } = await signer();
  const workos = new FakeWorkos();
  const relayed: RelayBatch[] = [];
  const deferred: Promise<unknown>[] = [];
  const limits: Array<[string, string]> = [];
  const logs: LogRecord[] = [];
  let allow = true;
  let withRelay = true;
  const deps = (): Deps => ({
    workos,
    clientId: CLIENT,
    verify: (t) =>
      verifyAccessToken(t, { apiBase: API, clientId: CLIENT, keys }),
    limit: async (bucket, key) => {
      limits.push([bucket, key]);
      return allow;
    },
    defer: (w) => {
      deferred.push(w);
    },
    relay: withRelay
      ? async (batch) => {
          relayed.push(batch);
        }
      : undefined,
  });
  const log = new Logger({ local: (r) => logs.push(r), remote() {} });
  const ORIGIN = 'https://web.test';
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    handle(
      new Request('https://cloud.test/v1/telemetry/logs', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '203.0.113.9', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      deps,
      [ORIGIN],
      log,
    );
  const reset = () => {
    relayed.length = 0;
    deferred.length = 0;
    limits.length = 0;
    logs.length = 0;
    allow = true;
    withRelay = true;
  };

  it('accepts an anonymous batch, rate-limited per IP, and forwards it', async () => {
    reset();
    const r = await post({ records: [rec()], resource });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ accepted: 1 });
    expect(limits).toEqual([['telemetry', '203.0.113.9']]);
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);
    expect(relayed).toHaveLength(1);
    expect(relayed[0]?.resource['enduser.id']).toBeUndefined();
    expect(relayed[0]?.records[0]?.attrs['theodore.relay']).toBe(true);
    const line = logs.find((l) => l.msg === 'telemetry relayed');
    expect(line?.attrs).toMatchObject({
      service: 'theodore-mobile',
      records: 1,
      dropped: 0,
      signed_in: false,
      forwarded: true,
    });
  });

  it('with a token, counts the user and keeps a matching enduser.id', async () => {
    reset();
    const t = await sign({ sub: 'user_7' });
    const r = await post(
      { records: [rec()], resource: { ...resource, 'enduser.id': 'user_7' } },
      { authorization: `Bearer ${t}` },
    );
    expect(r.status).toBe(202);
    expect(limits).toEqual([['user', 'user_7']]);
    await Promise.all(deferred);
    expect(relayed[0]?.resource['enduser.id']).toBe('user_7');
  });

  it('drops an enduser.id that is not the token’s user', async () => {
    reset();
    const t = await sign({ sub: 'user_7' });
    await post(
      { records: [rec()], resource: { ...resource, 'enduser.id': 'user_8' } },
      { authorization: `Bearer ${t}` },
    );
    await Promise.all(deferred);
    expect(relayed[0]?.resource['enduser.id']).toBeUndefined();
  });

  it('refuses a bad token instead of treating it as anonymous', async () => {
    reset();
    const r = await post(
      { records: [rec()], resource },
      { authorization: 'Bearer a.b.c' },
    );
    expect(r.status).toBe(401);
    expect(limits).toEqual([]);
    expect(relayed).toHaveLength(0);
  });

  it('answers 429 over the limit, forwarding nothing', async () => {
    reset();
    allow = false;
    const r = await post({ records: [rec()], resource });
    expect(r.status).toBe(429);
    expect(relayed).toHaveLength(0);
    expect(logs.find((l) => l.msg === 'rate limited')?.attrs.bucket).toBe(
      'telemetry',
    );
  });

  it('refuses an oversize body, too many records, bad JSON', async () => {
    reset();
    const big = await post({
      records: [rec({ msg: 'x'.repeat(70 * 1024) })],
      resource,
    });
    expect(big.status).toBe(413);
    const many = await post({ records: Array(101).fill(rec()), resource });
    expect(many.status).toBe(400);
    expect((await post('nope')).status).toBe(400);
    expect((await post([1])).status).toBe(400);
    expect(relayed).toHaveLength(0);
  });

  it('answers 202 and drops when no OTLP target is configured', async () => {
    reset();
    withRelay = false;
    const r = await post({ records: [rec()], resource });
    expect(r.status).toBe(202);
    expect(deferred).toHaveLength(0);
    expect(
      logs.find((l) => l.msg === 'telemetry relayed')?.attrs.forwarded,
    ).toBe(false);
  });

  it('answers 202 with nothing forwarded when every record is dropped', async () => {
    reset();
    const r = await post({ records: [rec({ level: 'info' })], resource });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ accepted: 0 });
    expect(deferred).toHaveLength(0);
  });

  it('allows the web app’s origin (CORS), no other', async () => {
    reset();
    const pre = await handle(
      new Request('https://cloud.test/v1/telemetry/logs', {
        method: 'OPTIONS',
        headers: { origin: ORIGIN },
      }),
      deps,
      [ORIGIN],
    );
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(pre.headers.get('access-control-allow-headers')).toBe(
      'Authorization, Content-Type',
    );
    const r = await post({ records: [rec()], resource }, { origin: ORIGIN });
    expect(r.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(r.headers.get('vary')).toBe('Origin');
    const other = await post(
      { records: [rec()], resource },
      { origin: 'https://evil.test' },
    );
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('logs the request line with route, status, latency and device kind', async () => {
    reset();
    await post({ records: [rec()], resource }, { 'user-agent': 'okhttp/4.9' });
    const line = logs.find((l) => l.msg === 'http request');
    expect(line?.attrs).toMatchObject({
      route: '/v1/telemetry/logs',
      method: 'POST',
      status: 202,
      device_kind: 'mobile',
    });
    expect(typeof line?.attrs.ms).toBe('number');
  });
});
