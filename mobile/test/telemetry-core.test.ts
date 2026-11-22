/**
 * The telemetry hub end to end: consent gating (nothing sent or queued
 * before a choice, per switch), identity (anonymous ─▶ account ─▶ a new
 * anonymous id on sign-out), batching and backoff, the relay's payload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '../src/keys/storage-types';
import { applyChoice, NO_CHOICE, parseChoice, useConsent } from '../src/telemetry/consent';
import { diagnosticsText, recordCount } from '../src/telemetry/export';
import { admit } from '../src/telemetry/errors';
import { isAccountId, loadIdentity } from '../src/telemetry/identity';
import { createTelemetry, type TelemetryDeps } from '../src/telemetry/log';
import { createQueue } from '../src/telemetry/queue';
import {
  RELAY_REQUEST_BYTES,
  relayBody,
  toRelayRecord,
} from '../src/telemetry/relay';
import { createRing, trimRing } from '../src/telemetry/ring';
import type { AppFacts, TelemetryRecord } from '../src/telemetry/types';

const FACTS: AppFacts = {
  app_version: '0.1.30',
  channel: 'store',
  platform: 'ios',
  os: 'ios',
  os_version: '18.1',
  build: 'abc1234',
  build_env: 'staging',
};
const USER = 'user_01ABCDEFGHIJKLMNOPQRSTUV';
const CLOUD = 'https://cloud.test';

interface Call {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function fakeFetch(status: () => number = () => 200) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return { status: status(), ok: status() < 300 } as Response;
  }) as unknown as typeof fetch;
  return { calls, fetch: fetchFn };
}

let uuid = 0;
const randomUUID = () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`;

async function rig(over: Partial<TelemetryDeps> = {}, posthog = true) {
  const net = fakeFetch();
  const t = createTelemetry();
  let token: string | null = null;
  const deps: TelemetryDeps = {
    storage: memoryStorage(),
    facts: FACTS,
    randomUUID,
    fetch: net.fetch,
    posthog: posthog ? { host: 'https://ph.test', key: 'phc_test' } : null,
    cloudUrl: CLOUD,
    token: async () => token,
    flushMs: 5,
    ringSaveDelayMs: 1,
    ...over,
  };
  await t.configure(deps);
  const posthogCalls = () => net.calls.filter((c) => c.url.startsWith('https://ph.test'));
  const relayCalls = () => net.calls.filter((c) => c.url.startsWith(CLOUD));
  return {
    t,
    net,
    posthogCalls,
    relayCalls,
    setToken: (v: string | null) => (token = v),
    flush: async () => {
      await t.flush();
      await new Promise((r) => setTimeout(r, 2));
    },
  };
}

beforeEach(() => {
  useConsent.setState({ choice: NO_CHOICE, loaded: false });
  uuid = 0;
});
afterEach(() => vi.useRealTimers());

describe('the choice', () => {
  it('starts absent; a first switch answers both; on is consent 2, off clears it', () => {
    expect(parseChoice(null)).toEqual(NO_CHOICE);
    const a = applyChoice(NO_CHOICE, { usage: true });
    expect(a).toEqual({ usage: true, errors: false, usageConsent: 2, errorsConsent: null });
    const b = applyChoice(a, { errors: true });
    expect(b.errorsConsent).toBe(2);
    const c = applyChoice(b, { usage: false });
    expect(c.usage).toBe(false);
    expect(c.usageConsent).toBeNull();
    expect(c.errorsConsent).toBe(2);
    expect(parseChoice(JSON.stringify(c))).toEqual(c);
    expect(parseChoice('{"usage":"yes"}')).toEqual({ ...NO_CHOICE });
  });
});

describe('consent gating', () => {
  it('sends and queues nothing before a choice', async () => {
    const r = await rig();
    r.t.track('app_started', { cold: true });
    r.t.log.warn('something broke', { 'error.code': 'x.y' });
    r.t.reportError('ui.uncaught', new Error('boom'));
    await r.flush();
    expect(r.net.calls).toEqual([]);
    expect(r.t.sinks().posthog?.queued()).toBe(0);
    expect(r.t.sinks().relay?.queued()).toBe(0);
    // The local log has them all the same.
    expect(r.t.records().map((x) => x.msg)).toEqual([
      'app_started',
      'something broke',
      'ui.uncaught',
    ]);
  });

  it('each switch gates its own sink', async () => {
    const r = await rig();
    await r.t.setChoice({ usage: true, errors: false });
    r.t.track('signed_in', { how: 'account' });
    r.t.log.warn('a warning');
    await r.flush();
    expect(r.posthogCalls().length).toBe(1);
    expect(r.relayCalls()).toEqual([]);

    await r.t.setChoice({ usage: false, errors: true });
    r.t.track('signed_out');
    r.t.log.warn('another warning');
    r.t.log.info('an info line never leaves');
    await r.flush();
    expect(r.posthogCalls().length).toBe(1);
    expect(r.relayCalls().length).toBe(1);
    const records = r.relayCalls()[0]!.body.records as { msg: string }[];
    expect(records.map((x) => x.msg)).toEqual(['another warning']);
  });

  it('turning a switch off drops what it had queued', async () => {
    const r = await rig({ flushMs: 10_000 });
    await r.t.setChoice({ usage: true, errors: true });
    r.t.track('app_started', { cold: false });
    r.t.log.error('bad');
    expect(r.t.sinks().posthog?.queued()).toBe(1);
    expect(r.t.sinks().relay?.queued()).toBe(1);
    await r.t.setChoice({ usage: false, errors: false });
    expect(r.t.sinks().posthog?.queued()).toBe(0);
    expect(r.t.sinks().relay?.queued()).toBe(0);
  });

  it('a build without a PostHog key has no usage sink', async () => {
    const r = await rig({}, false);
    expect(r.t.status().usageAvailable).toBe(false);
    expect(r.t.status().errorsAvailable).toBe(true);
    await r.t.setChoice({ usage: true, errors: true });
    r.t.track('app_started', { cold: true });
    await r.flush();
    expect(r.posthogCalls()).toEqual([]);
  });

  it('the catalog is enforced at runtime', async () => {
    const r = await rig();
    await r.t.setChoice({ usage: true });
    r.t.track('space_started', {
      mode: 'edit',
      ...({ goal: 'secret words', text: 'no' } as object),
    });
    (r.t.track as (e: string) => void)('not_an_event');
    await r.flush();
    const batch = r.posthogCalls()[0]!.body.batch as { event: string; properties: Record<string, unknown> }[];
    expect(batch.map((e) => e.event)).toEqual(['space_started']);
    expect(batch[0]!.properties.goal).toBeUndefined();
    expect(batch[0]!.properties.text).toBeUndefined();
    expect(batch[0]!.properties.mode).toBe('edit');
  });
});

describe('identity', () => {
  it('refuses anything not shaped like a provider user id', () => {
    expect(isAccountId(USER)).toBe(true);
    expect(isAccountId('jean@example.com')).toBe(false);
    expect(isAccountId('user_')).toBe(false);
    expect(isAccountId(null)).toBe(false);
  });

  it('is the install id until linking, then the account, then a new anon id', async () => {
    const storage = memoryStorage();
    const id = await loadIdentity(storage, randomUUID);
    expect(id.anonId()).toBe(id.installId());
    const again = await loadIdentity(storage, randomUUID);
    expect(again.installId()).toBe(id.installId());
    id.setAccount('jean@example.com');
    expect(id.account()).toBeNull();
    id.setAccount(USER);
    expect(id.usageAccount(NO_CHOICE)).toBeNull();
    const on = applyChoice(NO_CHOICE, { usage: true });
    expect(id.usageAccount(on)).toBe(USER);
    expect(id.errorsAccount(on)).toBeNull();
    expect(id.distinctId(on)).toBe(USER);
    const anon = await id.rotateAnon();
    expect(anon).not.toBe(id.installId());
    expect(id.anonId()).toBe(anon);
  });

  it('events carry the anon id signed out, the account signed in and agreed, $identify once, a new anon id after sign-out', async () => {
    const r = await rig();
    await r.t.setChoice({ usage: true, errors: true });
    r.t.track('app_started', { cold: true });
    await r.flush();
    let batch = r.posthogCalls()[0]!.body.batch as {
      event: string;
      distinct_id: string;
      properties: Record<string, unknown>;
    }[];
    const install = r.t.status().installId!;
    expect(batch[0]!.distinct_id).toBe(install);
    expect(batch[0]!.properties.$process_person_profile).toBe(false);
    expect(batch[0]!.properties.$geoip_disable).toBe(true);
    expect(batch[0]!.properties.app_version).toBe('0.1.30');
    expect(batch[0]!.properties.build_env).toBe('staging');

    await r.t.setAccount(USER);
    r.t.track('signed_in', { how: 'account' });
    await r.flush();
    batch = r.posthogCalls()[1]!.body.batch as typeof batch;
    const identify = batch.find((e) => e.event === '$identify')!;
    expect(identify.distinct_id).toBe(USER);
    // Linking starts from a fresh anonymous id, not the install id.
    expect(identify.properties.$anon_distinct_id).not.toBe(install);
    const signedIn = batch.find((e) => e.event === 'signed_in')!;
    expect(signedIn.distinct_id).toBe(USER);
    expect('$process_person_profile' in signedIn.properties).toBe(false);
    expect(JSON.stringify(batch)).not.toContain('@');

    // The relay names the account only with error-report consent.
    r.t.log.warn('w');
    await r.flush();
    const relay = r.relayCalls().at(-1)!.body.resource as Record<string, string>;
    expect(relay['enduser.id']).toBe(USER);
    expect(relay['service.instance.id']).toBe(install);

    await r.t.setAccount(null);
    r.t.track('signed_out');
    r.t.log.warn('w2');
    await r.flush();
    batch = r.posthogCalls().at(-1)!.body.batch as typeof batch;
    const out = batch.find((e) => e.event === 'signed_out')!;
    expect(out.distinct_id).not.toBe(USER);
    expect(out.distinct_id).not.toBe(install);
    expect(out.distinct_id).not.toBe(identify.properties.$anon_distinct_id);
    const relay2 = r.relayCalls().at(-1)!.body.resource as Record<string, string>;
    expect('enduser.id' in relay2).toBe(false);
    // The local log never has the account id.
    expect(r.t.exportText()).not.toContain(USER);
  });

  it('error reports alone never reach PostHog with the account, and usage alone never names it to the relay', async () => {
    const r = await rig();
    await r.t.setAccount(USER);
    await r.t.setChoice({ usage: false, errors: true });
    r.t.log.error('e');
    await r.flush();
    expect(r.posthogCalls()).toEqual([]);
    expect((r.relayCalls()[0]!.body.resource as Record<string, string>)['enduser.id']).toBe(USER);
    await r.t.setChoice({ usage: true, errors: false });
    r.t.log.error('e2');
    await r.flush();
    expect(r.relayCalls().length).toBe(1);
  });
});

describe('the relay payload', () => {
  it('has the records and resource shape, bounded', () => {
    const rec = toRelayRecord({
      ts: 5,
      level: 'warn',
      kind: 'error',
      msg: 'm'.repeat(5000),
      op_id: 'req_1',
      fields: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`k${i}`, i % 2 ? i : `v${i}`]),
      ),
    })!;
    expect(rec.msg.length).toBe(2000);
    expect(Object.keys(rec.attrs).length).toBeLessThanOrEqual(30);
    expect(rec.attrs.op_id).toBe('req_1');
    expect(rec.attrs.kind).toBe('error');
    expect(toRelayRecord({ ts: 1, level: 'info', kind: 'log', msg: 'x', fields: {} })).toBeNull();
    const body = relayBody([rec], FACTS, 'install-1', null);
    expect(body.resource).toEqual({
      'service.name': 'theodore-mobile',
      'service.version': '0.1.30',
      'os.type': 'ios',
      'deployment.environment.name': 'staging',
      'service.instance.id': 'install-1',
    });
    expect(relayBody([], FACTS, 'i', USER).resource['enduser.id']).toBe(USER);
  });

  it('posts to /v1/telemetry/logs with the bearer when signed in, under 64 KB a request', async () => {
    const r = await rig({ flushMs: 10_000 });
    await r.t.setChoice({ errors: true });
    r.setToken('jwt.abc.def');
    for (let i = 0; i < 60; i++)
      r.t.log.warn(`warning ${i}`, { detail: 'd'.repeat(1900), i });
    await r.flush();
    await r.flush();
    await r.flush();
    const calls = r.relayCalls();
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) {
      expect(c.url).toBe(`${CLOUD}/v1/telemetry/logs`);
      expect(c.headers.authorization).toBe('Bearer jwt.abc.def');
      expect(JSON.stringify(c.body).length).toBeLessThanOrEqual(RELAY_REQUEST_BYTES);
      for (const rec of c.body.records as { level: string }[])
        expect(['warn', 'error']).toContain(rec.level);
    }
    const total = calls.reduce((n, c) => n + (c.body.records as unknown[]).length, 0);
    expect(total).toBe(60);
  });

  it('goes without a bearer before sign-in', async () => {
    const r = await rig();
    await r.t.setChoice({ errors: true });
    r.t.reportError('ui.uncaught', new Error('early'));
    await r.flush();
    expect('authorization' in r.relayCalls()[0]!.headers).toBe(false);
  });
});

describe('batching and backoff', () => {
  it('sends a full batch at once, else after flushMs', async () => {
    const sent: number[][] = [];
    const q = createQueue<number>({
      send: async (b) => {
        sent.push(b);
        return 'ok';
      },
      batchSize: 3,
      flushMs: 20,
      attempts: 4,
      backoffMs: 5,
      backoffMaxMs: 50,
      maxQueued: 100,
      maxAgeMs: 10_000,
    });
    q.push(1);
    q.push(2);
    expect(sent).toEqual([]);
    q.push(3);
    await new Promise((r) => setTimeout(r, 2));
    expect(sent).toEqual([[1, 2, 3]]);
    q.push(4);
    await new Promise((r) => setTimeout(r, 40));
    expect(sent).toEqual([[1, 2, 3], [4]]);
  });

  it('retries with backoff on 5xx, keeps order, drops after its attempts; a 4xx drops at once', async () => {
    let status = 503;
    let tries = 0;
    const times: number[] = [];
    let now = 0;
    const q = createQueue<number>({
      send: async () => {
        tries += 1;
        times.push(now);
        return status === 200 ? 'ok' : status >= 500 ? 'retry' : 'drop';
      },
      batchSize: 10,
      flushMs: 1,
      attempts: 3,
      backoffMs: 100,
      backoffMaxMs: 1000,
      maxQueued: 100,
      maxAgeMs: 10_000,
      now: () => now,
      random: () => 0.5,
    });
    q.push(1);
    await q.flush();
    expect(tries).toBe(1);
    expect(q.size()).toBe(1);
    // Too early: nothing goes out.
    now = 50;
    await q.flush();
    expect(tries).toBe(1);
    now = 100;
    await q.flush();
    expect(tries).toBe(2);
    now = 400;
    await q.flush();
    expect(tries).toBe(3);
    // Out of attempts: dropped.
    expect(q.size()).toBe(0);

    status = 400;
    q.push(2);
    await q.flush();
    expect(q.size()).toBe(0);
    status = 200;
    q.push(3);
    await q.flush();
    expect(q.sent()).toBe(1);
  });

  it('drops the oldest over the cap and items that waited too long', async () => {
    let now = 0;
    const sent: number[][] = [];
    const q = createQueue<number>({
      send: async (b) => {
        sent.push(b);
        return 'ok';
      },
      batchSize: 50,
      flushMs: 100_000,
      attempts: 1,
      backoffMs: 1,
      backoffMaxMs: 1,
      maxQueued: 3,
      maxAgeMs: 1000,
      now: () => now,
    });
    q.push(1);
    q.push(2);
    q.push(3);
    q.push(4);
    expect(q.size()).toBe(3);
    now = 5000;
    q.push(5);
    await q.flush();
    expect(sent).toEqual([[5]]);
    q.clear();
  });

  it('PostHog batches go to /batch/ with the key, retried on 5xx', async () => {
    let status = 500;
    const net = fakeFetch(() => status);
    const t = createTelemetry();
    await t.configure({
      storage: memoryStorage(),
      facts: FACTS,
      randomUUID,
      fetch: net.fetch,
      posthog: { host: 'https://ph.test/', key: 'phc_k' },
      cloudUrl: CLOUD,
      token: async () => null,
      flushMs: 2,
      ringSaveDelayMs: 1,
      random: () => 0.5,
    });
    await t.setChoice({ usage: true });
    t.track('app_started', { cold: true });
    await t.flush();
    expect(net.calls[0]!.url).toBe('https://ph.test/batch/');
    expect(net.calls[0]!.body.api_key).toBe('phc_k');
    expect(t.sinks().posthog!.queued()).toBe(1);
    status = 200;
    await new Promise((r) => setTimeout(r, 2));
    // The backoff holds it; a flush after the wait sends it again.
    await new Promise((r) => setTimeout(r, 2100)).then(() => t.flush());
    expect(net.calls.length).toBeGreaterThanOrEqual(2);
    expect(t.sinks().posthog!.queued()).toBe(0);
  }, 10_000);
});

describe('the local log', () => {
  it('keeps the newest within its bounds and comes back after a restart', async () => {
    const storage = memoryStorage();
    const ring = createRing(storage, { max: 5, bytes: 100_000, saveDelayMs: 1 });
    await ring.load();
    for (let i = 0; i < 8; i++)
      ring.push({ ts: i, level: 'info', kind: 'log', msg: `m${i}`, fields: {} });
    expect(ring.records().map((r) => r.msg)).toEqual(['m3', 'm4', 'm5', 'm6', 'm7']);
    await ring.flush();
    const again = createRing(storage, { max: 5, bytes: 100_000 });
    again.push({ ts: 9, level: 'warn', kind: 'log', msg: 'm9', fields: {} });
    await again.load();
    expect(again.records().map((r) => r.msg)).toEqual(['m4', 'm5', 'm6', 'm7', 'm9']);
  });

  it('trims by bytes too, and drops records that are not records', () => {
    const big: TelemetryRecord[] = Array.from({ length: 10 }, (_, i) => ({
      ts: i,
      level: 'info',
      kind: 'log',
      msg: 'x'.repeat(100),
      fields: {},
    }));
    const out = trimRing(big, 100, 500);
    expect(out.length).toBeLessThan(10);
    expect(out.at(-1)!.ts).toBe(9);
  });

  it('exports with the remote rules, with an app-info header', async () => {
    const r = await rig();
    r.t.log.info('space start requested', {
      host_name: 'mac-A',
      host_device: 'dev_00000000-0000-4000-8000-0000000000b2',
      goal: 'fix the login bug',
    });
    const local = JSON.stringify(r.t.records());
    expect(local).toContain('mac-A');
    expect(local).not.toContain('fix the login');
    const text = diagnosticsText({
      facts: FACTS,
      installId: r.t.status().installId,
      log: r.t.exportText(),
      now: 0,
    });
    expect(text).not.toContain('mac-A');
    expect(text).toContain('dev_00000000-0000-4000-8000-0000000000b2');
    expect(text.startsWith('theodore-mobile 0.1.30')).toBe(true);
    expect(recordCount(r.t.exportText())).toBe(1);
  });

  it('records logged before configure() are kept, and op ids are 16 hex', async () => {
    const t = createTelemetry();
    t.log.info('early');
    const id = t.newOpId();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    await t.configure({
      storage: memoryStorage(),
      facts: FACTS,
      randomUUID,
      fetch: fakeFetch().fetch,
      posthog: null,
      cloudUrl: CLOUD,
      token: async () => null,
      ringSaveDelayMs: 1,
    });
    t.log.info('late', { op_id: id });
    expect(t.records().map((x) => x.msg)).toEqual(['early', 'late']);
    expect(t.records()[1]!.op_id).toBe(id);
  });
});

describe('JS errors', () => {
  it('are deduped within a window and rate-limited', () => {
    const t0 = 1_000_000;
    expect(admit(new Error('same'), t0)).toBe(true);
    expect(admit(new Error('same'), t0 + 100)).toBe(false);
    expect(admit(new Error('same'), t0 + 20_000)).toBe(true);
    let admitted = 0;
    for (let i = 0; i < 40; i++)
      if (admit(new Error(`e${i}`), t0 + 30_000 + i)) admitted += 1;
    expect(admitted).toBeLessThanOrEqual(20);
  });
});
