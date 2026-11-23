// The hub's alarm: after it runs, the next wake is null or in the future,
// whatever rows it found and whatever one of its steps did. A row left due
// would wake the Durable Object again at once, in a loop (as production did
// on 2026-11-22: 310k invocations in a day, most of them alarms).
import { describe, expect, it } from 'vitest';
import type { Delegation, RemoteAsk, RemoteConfirm } from '../src/gen/fleet';
import {
  ALARM_RETRY_MS,
  ESCALATE_MS,
  GRACE_MS,
  PENDING_TTL_MS,
  REQUEST_WINDOW_MS,
} from '../src/fleet/limits';
import { Logger, type LogRecord } from '../src/telemetry/log';
import { callTool } from '../src/mcp/tools';
import {
  Device,
  FakeConn,
  Harness,
  refusals,
  startOp,
  startSpace,
} from './fleet-harness';

const TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';

function logged() {
  const records: LogRecord[] = [];
  const log = new Logger({ local: (r) => records.push(r), remote: () => {} });
  return { log, of: (msg: string) => records.filter((r) => r.msg === msg) };
}

/** The last schedule the hub asked for is null or after now. */
function expectFuture(h: Harness, what: string) {
  const at = h.scheduled.at(-1);
  if (at === undefined || at === null) return;
  expect(at, `${what}: scheduled ${at - h.now} ms from now`).toBeGreaterThan(
    h.now,
  );
}

/**
 * A socket the runtime still lists for the user but whose state is gone
 * (never saved, or lost with its attachment): `state()` is null.
 */
function ghost(h: Harness, user: string): FakeConn {
  const c = new FakeConn(user);
  h.conns.push(c);
  return c;
}

async function raiseAsk(host: Device, space: string, id: string) {
  const ask: RemoteAsk = {
    ask_id: id,
    space,
    host_device: host.id!,
    from: 'host',
    questions: [{ question: 'Which?', options: ['a', 'b'], multi: false }],
  };
  await host.raise(ask);
}

async function raiseConfirm(host: Device, id: string, expiresAt: number) {
  const body: RemoteConfirm = {
    confirm_id: id,
    host_device: host.id!,
    mcp_device: 'dev_mcp',
    action: 'start',
    mode: 'edit',
    project_name: 'theodore',
    space_name: null,
    text: 'ok?',
    expires_at_ms: expiresAt,
  };
  await host.send({
    type: 'confirm',
    envelope: await host.seal('confirm', body),
  });
}

async function delegate(
  origin: Device,
  to: Device,
  over: Partial<Delegation> = {},
) {
  const body: Delegation = {
    origin_device: origin.id!,
    delegate_device: to.id!,
    issued_at_ms: origin.h.now,
    expires_at_ms: 0,
    revoke: false,
    ...over,
  };
  await origin.send({
    type: 'delegate',
    envelope: await origin.seal('delegate', body),
  });
}

describe('the alarm never leaves a row due', () => {
  it('refuses a waiting request even when a socket of the user has no state', async () => {
    // Before the fix: the socket with no state threw inside the alarm's
    // first step (closing an expired connection), the request after it was
    // never refused, and the next wake was already due.
    const h = new Harness();
    const mac1 = await h.device('user_1', 'mac1');
    const mac2 = await h.device('user_1', 'mac2');
    const mac3 = await h.device('user_1', 'mac3');
    await mac1.connect();
    await mac2.connect();
    await mac2.disconnect();
    ghost(h, 'user_1');
    // Its token expires soon: the first due row is its connection.
    await mac3.connect({ expMs: h.now + 5_000 });
    await mac1.request(mac2.id!, startOp('rs_1'));
    mac1.clear();
    await h.tick(70_000);
    expect(mac3.conn.open).toBe(false);
    expect(refusals(mac1)).toEqual(['fleet.offline']);
    expectFuture(h, 'after the alarm');
  });

  it('closes a socket with no state that speaks, instead of throwing', async () => {
    const h = new Harness();
    const g = ghost(h, 'user_1');
    await h.hub.message(g, JSON.stringify({ type: 'presence' }));
    expect(g.open).toBe(false);
    expect(g.closedWith?.code).toBe(1008);
    await h.hub.closed(g);
    expectFuture(h, 'after a ghost');
  });

  it('marks a question escalated even if showing it fails', async () => {
    const { log, of } = logged();
    const h = new Harness(undefined, { log });
    const mac1 = await h.device('user_1', 'mac1');
    const mac2 = await h.device('user_1', 'mac2');
    await mac1.connect();
    await mac2.connect();
    await startSpace(mac1, mac2, 'rs_1');
    await mac1.disconnect();
    await raiseAsk(mac2, 'rs_1', 'ask_1');
    // The origin comes back as a socket whose send blows up.
    await mac1.connect();
    mac1.conn.send = () => {
      throw new TypeError('socket gone');
    };
    const sendOnce = mac1.conn.send;
    await h.tick(ESCALATE_MS + 1);
    expect(mac1.conn.send).toBe(sendOnce);
    expect(
      h.db.prepare('SELECT escalated FROM asks WHERE ask_id = ?').all('ask_1'),
    ).toEqual([{ escalated: 1 }]);
    expectFuture(h, 'after escalation');
    expect(of('fleet alarm stuck')).toEqual([]);
  });

  it('logs a row it cannot clear and tries again later, not at once', async () => {
    const { log, of } = logged();
    const h = new Harness(undefined, { log });
    const mac = await h.device('user_1', 'mac');
    await mac.connect();
    await h.hub.purgeUser('user_2');
    // The gone_users row refuses to go: a bug stands in for one.
    const run = h.hub.store.run.bind(h.hub.store);
    h.hub.store.run = (q, ...b) => {
      if (q.includes('DELETE FROM gone_users')) throw new Error('no');
      run(q, ...b);
    };
    await h.tick(24 * 3_600_000 + 1);
    expect(of('fleet alarm step failed')).toHaveLength(1);
    expect(of('fleet alarm step failed')[0]!.attrs).toMatchObject({
      step: 'forget deleted users',
      'error.message': 'no',
    });
    const stuck = of('fleet alarm stuck');
    expect(stuck).toHaveLength(1);
    expect(stuck[0]!.attrs).toMatchObject({ terms: 'gone_users', late_ms: 1 });
    expect(h.scheduled.at(-1)).toBe(h.now + ALARM_RETRY_MS);
    // Until then, nothing moves it earlier.
    await mac.send({
      type: 'presence',
      focused: true,
      locked: false,
      idle_ms: 0,
    });
    expect(h.scheduled.at(-1)).toBe(h.now + ALARM_RETRY_MS);
    // Cleared on the retry, the next wake is the token's deadline.
    h.hub.store.run = run;
    await h.tick(ALARM_RETRY_MS);
    expect(of('fleet alarm stuck')).toHaveLength(1);
    expect(h.db.prepare('SELECT * FROM gone_users').all()).toEqual([]);
    expectFuture(h, 'after the retry');
  });

  it('every kind of row: null or in the future after each wake', async () => {
    const h = new Harness(undefined, { mcp: true, replyWaitMs: 1 });
    const mac1 = await h.device('user_1', 'mac1');
    const mac2 = await h.device('user_1', 'mac2');
    const phone = await h.phone('user_1', 'phone');
    const other = await h.device('user_2', 'other');
    await mac1.connect({ expMs: h.now + 30_000 }); // conns: token + 60 s
    await mac2.connect();
    await phone.connect();
    await other.connect();
    await phone.send({ type: 'register_push', provider: 'expo', token: TOKEN });
    ghost(h, 'user_1');
    await startSpace(mac1, mac2, 'rs_1');
    await raiseAsk(mac2, 'rs_1', 'ask_1'); // asks: 20 s
    await raiseConfirm(mac2, 'c_1', h.now + 45_000); // confirms: expiry
    await raiseConfirm(mac2, 'c_2', h.now + 2 * REQUEST_WINDOW_MS); // capped
    await delegate(mac2, phone, { expires_at_ms: h.now + 25_000 });
    await delegate(mac1, phone);
    await delegate(mac1, mac2, { revoke: true }); // a tombstone
    await callTool(
      h.mcp!,
      { userId: 'user_1', orgId: 'org_1' },
      'devices_list',
      {},
    );
    await phone.disconnect();
    await mac1.request(phone.id!, startOp('rs_2')); // pending: 10 s grace
    await mac1.request(mac2.id!, startOp('rs_3')); // pending: 2 min ttl
    await mac2.disconnect(); // a reply for it will wait: replies 2 min
    await h.hub.purgeUser('user_2'); // gone_users: a day
    // A connection that never says hello: 10 s.
    await (await h.device('user_1', 'slow')).open();
    expectFuture(h, 'before any wake');
    const horizons = [
      1,
      GRACE_MS,
      ESCALATE_MS,
      30_000,
      60_000,
      PENDING_TTL_MS,
      REQUEST_WINDOW_MS,
      3_600_000,
      24 * 3_600_000,
      31 * 24 * 3_600_000,
    ];
    for (const ms of horizons) {
      await h.tick(ms);
      await h.settle();
      expectFuture(h, `after ${ms} ms`);
      // Woken again at once (a stale alarm): still nothing due.
      await h.tick(0);
      expectFuture(h, `woken again after ${ms} ms`);
    }
    expect(h.scheduled.at(-1)).toBeNull();
  });
});

describe('the alarm under random fleet activity', () => {
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  async function run(seed: number) {
    const r = rng(seed);
    const pick = <T>(xs: T[]): T | undefined => xs[Math.floor(r() * xs.length)];
    const h = new Harness(undefined, { mcp: true, replyWaitMs: 1 });
    const devs: Device[] = [];
    for (const n of ['mac1', 'mac2', 'mac3']) {
      devs.push(await h.device('user_1', n));
    }
    devs.push(await h.phone('user_1', 'phone'));
    devs.push(await h.device('user_2', 'other'));
    const online = () => devs.filter((d) => d.conn?.open && d.id);
    const ofUser = (ds: Device[]) => ds.filter((d) => d.user === 'user_1');
    let spaces = 0;
    let asks = 0;
    let confirms = 0;
    for (let i = 0; i < 60; i++) {
      try {
        switch (Math.floor(r() * 14)) {
          case 0:
          case 1: {
            const d = pick(devs)!;
            if (d.conn?.open) break;
            const exp = pick([3_600_000, 30_000, -1, 70_000])!;
            await d.connect({ expMs: h.now + exp });
            break;
          }
          case 2: {
            const d = pick(devs)!;
            if (d.conn?.open) await d.disconnect();
            break;
          }
          case 3: {
            const d = pick(devs)!;
            if (!d.conn?.open) await d.open({ expMs: h.now + 5_000 });
            break;
          }
          case 4: {
            const a = pick(ofUser(online()));
            const t = pick(ofUser(devs.filter((d) => d.id)));
            if (!a || !t || a === t) break;
            if (t.conn?.open && r() < 0.6) {
              await startSpace(a, t, `rs_${++spaces}`);
            } else {
              await a.request(t.id!, {
                op: 'stop',
                space: `rs_${spaces || 1}`,
              });
            }
            break;
          }
          case 5: {
            const host = pick(ofUser(online()));
            const row = host
              ? (h.db
                  .prepare('SELECT space FROM spaces WHERE host_device = ?')
                  .all(host.id!) as { space: string }[])
              : [];
            if (host && row[0])
              await raiseAsk(host, row[0].space, `ask_${++asks}`);
            break;
          }
          case 6: {
            const d = pick(online());
            if (!d) break;
            await d.send({
              type: 'presence',
              focused: r() < 0.7,
              locked: r() < 0.2,
              idle_ms: Math.floor(r() * 90_000),
            });
            break;
          }
          case 7: {
            const host = pick(
              ofUser(online()).filter((d) => d.name !== 'phone'),
            );
            if (!host) break;
            const ttl = pick([1_000, 60_000, 600_000])!;
            await raiseConfirm(host, `c_${++confirms}`, h.now + ttl);
            break;
          }
          case 8: {
            const o = pick(ofUser(online()));
            const dl = pick(ofUser(devs.filter((d) => d.id)));
            if (!o || !dl || o === dl) break;
            await delegate(o, dl, {
              expires_at_ms: pick([0, h.now + 5_000, h.now + 120_000])!,
              revoke: r() < 0.3,
            });
            break;
          }
          case 9: {
            const d = pick(online());
            if (d) {
              await d.send({
                type: 'register_push',
                provider: 'expo',
                token: TOKEN,
              });
            }
            break;
          }
          case 10: {
            const rows = h.db
              .prepare(
                'SELECT req_id, target_device, generation FROM pending WHERE claimed = 0',
              )
              .all() as {
              req_id: string;
              target_device: string;
              generation: number;
            }[];
            const p = pick(rows);
            const t = p && devs.find((d) => d.id === p.target_device);
            if (!p || !t?.conn?.open) break;
            await t.send({
              type: 'claim',
              req_id: p.req_id,
              generation: p.generation,
            });
            if (r() < 0.7)
              await t.reply(p.req_id, { outcome: 'ok', value: null });
            break;
          }
          case 11: {
            await callTool(
              h.mcp!,
              { userId: 'user_1', orgId: 'org_1' },
              'devices_list',
              {},
            );
            break;
          }
          case 12: {
            if (r() < 0.1) await h.hub.purgeUser('user_2');
            break;
          }
          default: {
            const ms = pick([
              1, 500, 5_000, 10_000, 20_001, 60_000, 120_001, 300_001,
              1_000_000,
            ])!;
            await h.tick(ms);
            await h.settle();
            expectFuture(h, `seed ${seed}, step ${i}: after ${ms} ms`);
            await h.tick(0);
            expectFuture(h, `seed ${seed}, step ${i}: woken again`);
          }
        }
      } catch (e) {
        // A refused op (no challenge, a closed socket) is part of the mix;
        // a failed expectation is not.
        if (e instanceof Error && e.message.includes('seed')) throw e;
      }
    }
    await h.tick(1);
    expectFuture(h, `seed ${seed}: at the end`);
  }

  it('never schedules a wake in the past', async () => {
    for (let seed = 1; seed <= 40; seed++) await run(seed);
  });
});
