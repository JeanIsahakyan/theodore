import { describe, expect, it } from 'vitest';
import {
  cloudResource,
  createTelemetry,
  otlpTarget,
  telemetryFor,
} from '../src/telemetry/cloud';
import type { LogRecord } from '../src/telemetry/log';
import {
  LogBatcher,
  MAX_BATCH,
  otlpLogsPayload,
  parseOtlpHeaders,
  sendLogs,
} from '../src/telemetry/otlp';

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A fetch that records what it got and answers `status`. */
function fakeFetch(status = 200) {
  const sent: Sent[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(null, { status });
  }) as typeof fetch;
  return { sent, fetchFn };
}

const record = (over: Partial<LogRecord> = {}): LogRecord => ({
  ts: 1_700_000_000_123,
  level: 'warn',
  msg: 'hi',
  attrs: { a: 1, b: 'x', c: true, d: 1.5 },
  ...over,
});

describe('OTLP payload', () => {
  it('parses k=v headers', () => {
    expect(parseOtlpHeaders('api-key=abc, x-y = z=1,bad,=v,k=')).toEqual({
      'api-key': 'abc',
      'x-y': 'z=1',
    });
    expect(parseOtlpHeaders(undefined)).toEqual({});
  });

  it('shapes resource, scope and log records as OTLP/HTTP JSON', () => {
    const payload = otlpLogsPayload(
      {
        'service.name': 'theodore-cloud',
        'deployment.environment.name': 'staging',
      },
      'theodore-cloud',
      [record()],
    ) as {
      resourceLogs: {
        resource: { attributes: unknown[] };
        scopeLogs: {
          scope: { name: string };
          logRecords: Record<string, unknown>[];
        }[];
      }[];
    };
    const rl = payload.resourceLogs[0]!;
    expect(rl.resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: 'theodore-cloud' } },
      { key: 'deployment.environment.name', value: { stringValue: 'staging' } },
    ]);
    const scope = rl.scopeLogs[0]!;
    expect(scope.scope.name).toBe('theodore-cloud');
    const lr = scope.logRecords[0]!;
    expect(lr.timeUnixNano).toBe('1700000000123000000');
    expect(lr.severityNumber).toBe(13);
    expect(lr.severityText).toBe('WARN');
    expect(lr.body).toEqual({ stringValue: 'hi' });
    expect(lr.attributes).toEqual([
      { key: 'a', value: { intValue: '1' } },
      { key: 'b', value: { stringValue: 'x' } },
      { key: 'c', value: { boolValue: true } },
      { key: 'd', value: { doubleValue: 1.5 } },
    ]);
  });

  it('posts to <endpoint>/v1/logs with the headers', async () => {
    const { sent, fetchFn } = fakeFetch(202);
    const out = await sendLogs(
      fetchFn,
      { endpoint: 'https://otlp.test/', headers: { 'api-key': 'k' } },
      { 'service.name': 's' },
      'scope',
      [record()],
    );
    expect(out).toEqual({ ok: true, status: 202 });
    expect(sent[0]?.url).toBe('https://otlp.test/v1/logs');
    expect(sent[0]?.headers['api-key']).toBe('k');
    expect(sent[0]?.headers['content-type']).toBe('application/json');
  });

  it('never throws', async () => {
    const boom = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const out = await sendLogs(
      boom,
      { endpoint: 'https://otlp.test', headers: { a: 'b' } },
      {},
      'scope',
      [record()],
    );
    expect(out).toEqual({ ok: false, kind: 'TypeError' });
    expect(
      await sendLogs(
        fakeFetch(403).fetchFn,
        { endpoint: 'x', headers: {} },
        {},
        's',
        [record()],
      ),
    ).toEqual({ ok: false, status: 403 });
  });
});

describe('LogBatcher', () => {
  it('coalesces flushes and bounds the queue', async () => {
    const batches: LogRecord[][] = [];
    const b = new LogBatcher(async (r) => {
      batches.push(r);
    }, 0);
    for (let i = 0; i < MAX_BATCH + 5; i++) b.push(record({ attrs: { i } }));
    expect(b.size).toBe(MAX_BATCH);
    expect(b.dropped).toBe(5);
    const p1 = b.flush();
    const p2 = b.flush();
    expect(p1).toBe(p2);
    await p1;
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(MAX_BATCH);
    // The oldest went.
    expect(batches[0]?.[0]?.attrs.i).toBe(5);
    await b.flush();
    expect(batches).toHaveLength(1);
  });
});

describe('cloud telemetry', () => {
  const env = {
    THEODORE_OTLP_ENDPOINT: 'https://otlp.test',
    THEODORE_OTLP_HEADERS: 'api-key=lic',
    THEODORE_ENV: 'staging',
  };

  it('needs both the endpoint and the headers', () => {
    expect(otlpTarget(env)).toEqual({
      endpoint: 'https://otlp.test',
      headers: { 'api-key': 'lic' },
    });
    expect(
      otlpTarget({ THEODORE_OTLP_ENDPOINT: 'https://otlp.test' }),
    ).toBeNull();
    expect(otlpTarget({ THEODORE_OTLP_HEADERS: 'api-key=lic' })).toBeNull();
    expect(cloudResource(env)['deployment.environment.name']).toBe('staging');
    expect(cloudResource({})['deployment.environment.name']).toBe('local');
  });

  it('sends its own warn/error records as theodore-cloud on flush', async () => {
    const { sent, fetchFn } = fakeFetch();
    const quiet = { local() {}, remote() {} };
    const t = createTelemetry(env, { fetch: fetchFn, linger: 0, local: quiet });
    expect(t.remote).toBe(true);
    t.log.info('not remote');
    t.log.warn('careful', { user_id: 'user_1' });
    t.log.info('http request', { route: '/v1/health', status: 200 });
    expect(sent).toHaveLength(0);
    await t.flush();
    expect(sent).toHaveLength(1);
    const body = sent[0]!.body as {
      resourceLogs: {
        resource: {
          attributes: { key: string; value: { stringValue: string } }[];
        };
        scopeLogs: { logRecords: { body: { stringValue: string } }[] }[];
      }[];
    };
    const resource = Object.fromEntries(
      body.resourceLogs[0]!.resource.attributes.map((a) => [
        a.key,
        a.value.stringValue,
      ]),
    );
    expect(resource).toEqual({
      'service.name': 'theodore-cloud',
      'deployment.environment.name': 'staging',
      'cloud.provider': 'cloudflare',
      'cloud.platform': 'cloudflare_workers',
    });
    const msgs = body.resourceLogs[0]!.scopeLogs[0]!.logRecords.map(
      (r) => r.body.stringValue,
    );
    expect(msgs).toEqual(['careful', 'http request']);
    expect(JSON.stringify(body)).not.toContain('user_1');
    expect(JSON.stringify(body)).toContain('h:');
  });

  it('with no target, logs locally only and drops relay batches', async () => {
    const { sent, fetchFn } = fakeFetch();
    const seen: string[] = [];
    const t = createTelemetry(
      { THEODORE_ENV: 'local' },
      {
        fetch: fetchFn,
        linger: 0,
        local: { local: (r) => seen.push(r.msg), remote() {} },
      },
    );
    expect(t.remote).toBe(false);
    t.log.error('boom');
    await t.relay({
      resource: { 'service.name': 'theodore-mobile' },
      records: [record()],
    });
    await t.flush();
    expect(sent).toHaveLength(0);
    expect(seen).toEqual(['boom']);
  });

  it('relays a batch under the client’s resource and logs a failure', async () => {
    const { sent, fetchFn } = fakeFetch(403);
    const seen: string[] = [];
    const t = createTelemetry(env, {
      fetch: fetchFn,
      linger: 0,
      local: { local: (r) => seen.push(r.msg), remote() {} },
    });
    await t.relay({
      resource: {
        'service.name': 'theodore-mobile',
        'service.version': '1.2.3',
      },
      records: [record()],
    });
    expect(sent).toHaveLength(1);
    const text = JSON.stringify(sent[0]!.body);
    expect(text).toContain('theodore-mobile');
    expect(text).toContain('"theodore-relay"');
    expect(seen).toEqual(['telemetry relay failed']);
  });

  it('is made once per bindings', () => {
    const a = telemetryFor(env);
    expect(telemetryFor(env)).toBe(a);
    expect(telemetryFor({ ...env, THEODORE_ENV: 'production' })).not.toBe(a);
  });
});
