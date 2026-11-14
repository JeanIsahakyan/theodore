// The byte budget for stored events, at its real sizes: 4 MB per space,
// 64 MB per user.
import { describe, expect, it } from 'vitest';
import {
  CLOUD_RING,
  MAX_SPACE_EVENT_BYTES,
  MAX_USER_EVENT_BYTES,
} from '../src/fleet/limits';
import { Harness, startSpace, type Device } from './fleet-harness';

/** A reply event whose signed body is a bit under 63 KB. */
const big = (turn: number) => ({
  kind: 'reply' as const,
  turn,
  text: 'x'.repeat(62_800),
});

async function pair() {
  const h = new Harness();
  const mac1 = await h.device('user_1', 'mac1');
  const mac2 = await h.device('user_1', 'mac2');
  await mac1.connect();
  await mac2.connect();
  return { h, mac1, mac2 };
}

/** One event, paced under the rate limit; the error code it got, if any. */
async function emit(
  h: Harness,
  host: Device,
  space: string,
  seq: number,
  event: Parameters<Device['emit']>[2] = big(seq),
): Promise<string | undefined> {
  h.now += 25;
  await host.emit(space, seq, event);
  return host.take('error')[0]?.code;
}

const q = <T>(h: Harness, sql: string, ...b: (string | number)[]) =>
  h.db.prepare(sql).all(...b)[0] as T;

const stored = (h: Harness, space: string) =>
  q<{ n: number; bytes: number; min: number | null; max: number | null }>(
    h,
    `SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes,
       MIN(seq) AS min, MAX(seq) AS max FROM events WHERE space = ?`,
    space,
  );

const userBytes = (h: Harness, user: string) =>
  q<{ b: number }>(
    h,
    `SELECT COALESCE(SUM(bytes + started_bytes), 0) AS b FROM spaces
     WHERE user_id = ?`,
    user,
  ).b;

describe('fleet event budget', () => {
  it(`keeps at most ${MAX_SPACE_EVENT_BYTES} bytes per space, oldest out`, async () => {
    const { h, mac1, mac2 } = await pair();
    await startSpace(mac1, mac2, 'rs_1');
    expect(
      await emit(h, mac2, 'rs_1', 1, {
        kind: 'started',
        host_device: mac2.id!,
        origin_device: mac1.id!,
        project_id: 'p1',
        project_name: 'theodore',
        name: 'S',
        branch: 'b',
        mode: 'edit',
        depth: 0,
      }),
    ).toBeUndefined();
    for (let seq = 2; seq <= 90; seq++) {
      expect(await emit(h, mac2, 'rs_1', seq)).toBeUndefined();
    }
    const s = stored(h, 'rs_1');
    expect(s.n).toBeLessThan(CLOUD_RING);
    expect(s.bytes).toBeLessThanOrEqual(MAX_SPACE_EVENT_BYTES);
    expect(s.bytes + 63_000).toBeGreaterThan(MAX_SPACE_EVENT_BYTES);
    expect(s.max).toBe(90);
    // The space's counter matches its rows.
    expect(
      q<{ bytes: number }>(
        h,
        'SELECT bytes FROM spaces WHERE space = ?',
        'rs_1',
      ).bytes,
    ).toBe(s.bytes);
    // A late subscriber: the started event (kept apart), the gap, the rest.
    mac1.clear();
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    expect(mac1.stream()).toEqual([
      1,
      `gap2-${s.min! - 1}`,
      ...Array.from({ length: 90 - s.min! + 1 }, (_, i) => s.min! + i),
    ]);
  });

  it(`keeps at most ${MAX_USER_EVENT_BYTES} bytes per user: finished spaces' oldest first, then fleet.busy`, async () => {
    const { h, mac1, mac2 } = await pair();
    // rs_0 finished with 5 events; rs_1.. running, filled to 4 MB each
    // until the budget is spent: rs_0's events go first, then refused.
    for (let i = 0; i <= 17; i++) {
      h.now += 100;
      await startSpace(mac1, mac2, `rs_${i}`);
    }
    for (let seq = 1; seq <= 5; seq++) {
      expect(await emit(h, mac2, 'rs_0', seq)).toBeUndefined();
    }
    expect(
      await emit(h, mac2, 'rs_0', 6, { kind: 'status', status: 'stopped' }),
    ).toBeUndefined();
    const full: Record<string, number> = {};
    let last = '';
    let refused = 0;
    let code: string | undefined;
    fill: for (let i = 1; i <= 17; i++) {
      last = `rs_${i}`;
      for (let seq = 1; seq <= 70; seq++) {
        code = await emit(h, mac2, last, seq);
        if (code) {
          refused = seq;
          break fill;
        }
      }
      full[last] = stored(h, last).n;
    }
    expect(code).toBe('fleet.busy');
    expect(stored(h, last).max).toBe(refused - 1);
    // The finished space gave up its events; the running ones kept theirs.
    expect(stored(h, 'rs_0').n).toBe(0);
    expect(Object.keys(full).length).toBeGreaterThanOrEqual(15);
    for (const [sp, n] of Object.entries(full)) {
      expect(stored(h, sp).n).toBe(n);
    }
    expect(userBytes(h, 'user_1')).toBeLessThanOrEqual(MAX_USER_EVENT_BYTES);
    // The space itself stays: its history is a gap now.
    mac1.clear();
    await mac1.send({ type: 'subscribe', space: 'rs_0', since: 0 });
    expect(mac1.stream()).toEqual(['gap1-6']);
    // Not stored, not counted: the host resumes from the last one kept.
    await mac2.disconnect();
    expect((await mac2.connect()).resume[last]).toBe(refused - 1);

    // Another user has a budget of their own.
    const a = await h.device('user_2', 'a');
    const b = await h.device('user_2', 'b');
    await a.connect();
    await b.connect();
    await startSpace(a, b, 'rs_theirs');
    expect(await emit(h, b, 'rs_theirs', 1)).toBeUndefined();

    // rs_1 finishes: the journaled event now fits, from rs_1's oldest.
    const before = stored(h, 'rs_1').n;
    expect(
      await emit(h, mac2, 'rs_1', 71, { kind: 'status', status: 'stopped' }),
    ).toBeUndefined();
    expect(await emit(h, mac2, last, refused)).toBeUndefined();
    expect(stored(h, last).max).toBe(refused);
    expect(stored(h, 'rs_1').n).toBeLessThan(before + 1);
    expect(userBytes(h, 'user_1')).toBeLessThanOrEqual(MAX_USER_EVENT_BYTES);
  });
});
