// Mirrored rows (docs/fleet.md "One space UI: mirrored rows"): `space` and
// `chat_message` kept as the latest per id, `turn_step` relayed only.
import { describe, expect, it } from 'vitest';
import type { RemoteSpaceEvent, SpaceEventBody } from '../src/gen/fleet';
import {
  CLOUD_RING,
  MAX_EVENT_BYTES,
  MAX_MIRROR_ID_CHARS,
  MAX_SPACE_EVENT_BYTES,
} from '../src/fleet/limits';
import { Store } from '../src/fleet/store';
import { Harness, startSpace, type Device } from './fleet-harness';

const status: RemoteSpaceEvent = { kind: 'status', status: 'running' };

const mirror = (model: string, id: string, data: unknown = { id }) =>
  ({ kind: 'mirror', model, id, data }) as RemoteSpaceEvent;

/** A mirror whose signed body is a bit under 63 KB. */
const bigMirror = (id: string) =>
  mirror('chat_message', id, 'x'.repeat(62_800));

// mac1 (origin, protocol `originProtocol`) started rs_1 on mac2 (host).
async function setup(originProtocol = 4) {
  const h = new Harness();
  const mac1 = await h.device('user_1', 'mac1');
  const mac2 = await h.device('user_1', 'mac2');
  mac1.protocol = originProtocol;
  await mac1.connect();
  await mac2.connect();
  await startSpace(mac1, mac2, 'rs_1');
  mac1.clear();
  mac2.clear();
  const emit = async (seq: number, event = status, host: Device = mac2) => {
    h.now += 25; // stay under the rate limit
    await host.emit('rs_1', seq, event);
    return host.take('error')[0]?.code;
  };
  return { h, mac1, mac2, emit };
}

const count = (h: Harness, table: string, space = 'rs_1') =>
  (
    h.db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE space = ?`)
      .all(space)[0] as { n: number }
  ).n;

const space = (h: Harness, id = 'rs_1') =>
  h.db.prepare('SELECT * FROM spaces WHERE space = ?').all(id)[0] as {
    bytes: number;
    mirror_bytes: number;
    last_seq: number;
    lost_to: number;
  };

/** Received space events: seq and what they were (`kind` or `model:id`). */
function events(d: Device): string[] {
  const out: string[] = [];
  for (const m of d.sent) {
    if (m.type === 'space_gap') out.push(`gap${m.from}-${m.to}`);
    if (m.type !== 'space_event') continue;
    const b = JSON.parse(m.envelope.body) as SpaceEventBody;
    const ev = b.event;
    out.push(
      ev.kind === 'mirror'
        ? `${b.seq} ${ev.model}:${ev.id}${ev.data === null ? ' ✗' : ''}`
        : `${b.seq} ${ev.kind}`,
    );
  }
  d.sent.length = 0;
  return out;
}

describe('fleet mirrors', () => {
  it('keeps only the latest mirror per row, out of the ring', async () => {
    const { h, mac1, emit } = await setup();
    await emit(1, mirror('chat_message', 'm1', { text: 'a' }));
    await emit(2, mirror('chat_message', 'm1', { text: 'ab' }));
    await emit(3, mirror('chat_message', 'm2'));
    await emit(4, mirror('space', 'rs_1'));
    await emit(5, status);
    await emit(6, mirror('space', 'rs_1'));
    expect(count(h, 'mirrors')).toBe(3);
    expect(count(h, 'events')).toBe(1);
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    expect(events(mac1)).toEqual([
      '2 chat_message:m1',
      '3 chat_message:m2',
      '5 status',
      '6 space:rs_1',
    ]);
    // The kept one is the newest, as the host signed it.
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 2 });
    expect(events(mac1)).toEqual([
      '3 chat_message:m2',
      '5 status',
      '6 space:rs_1',
    ]);
  });

  it('keeps a tombstone as the latest', async () => {
    const { h, mac1, emit } = await setup();
    await emit(1, mirror('chat_message', 'm1'));
    await emit(2, mirror('chat_message', 'm1', null));
    expect(count(h, 'mirrors')).toBe(1);
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    expect(events(mac1)).toEqual(['2 chat_message:m1 ✗']);
    // Still the latest: a newer row comes back over it.
    await emit(3, mirror('chat_message', 'm1'));
    expect(events(mac1)).toEqual(['3 chat_message:m1']);
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    expect(events(mac1)).toEqual(['3 chat_message:m1']);
  });

  it('relays a turn_step live and never stores it', async () => {
    const { h, mac1, mac2, emit } = await setup();
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    await emit(1, status);
    await emit(2, mirror('turn_step', 'run_1:0'));
    await emit(3, mirror('turn_step', 'run_1:1'));
    expect(events(mac1)).toEqual([
      '1 status',
      '2 turn_step:run_1:0',
      '3 turn_step:run_1:1',
    ]);
    expect(count(h, 'events')).toBe(1);
    expect(count(h, 'mirrors')).toBe(0);
    expect(space(h).last_seq).toBe(3);
    // A replay of it is dropped like any other.
    await emit(3, mirror('turn_step', 'run_1:1'));
    expect(events(mac1)).toEqual([]);
    // History: no step, no gap where it was.
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    expect(events(mac1)).toEqual(['1 status']);
    // The host resumes after it.
    await mac2.disconnect();
    expect((await mac2.connect()).resume).toEqual({ rs_1: 3 });
  });

  it('reports no gap for holes left by compaction or steps', async () => {
    const { mac1, emit } = await setup();
    await emit(1, status);
    await emit(2, mirror('chat_message', 'm1'));
    await emit(3, mirror('turn_step', 'r:0'));
    await emit(4, mirror('chat_message', 'm1'));
    await emit(5, status);
    await emit(6, mirror('turn_step', 'r:1'));
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    expect(events(mac1)).toEqual(['1 status', '4 chat_message:m1', '5 status']);
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 1 });
    expect(events(mac1)).toEqual(['4 chat_message:m1', '5 status']);
    // The host's journal compacted too: its replay jumps, still no gap.
    await emit(9, mirror('space', 'rs_1'));
    expect(events(mac1)).toEqual(['9 space:rs_1']);
  });

  it('doesn’t push events out of the ring; real ring loss is still a gap', async () => {
    const { h, mac1, emit } = await setup();
    await emit(1, mirror('space', 'rs_1'));
    for (let s = 2; s <= CLOUD_RING + 1; s++) await emit(s, status);
    // Many rows: the ring stays whole.
    const rows = 50;
    for (let i = 0; i < rows; i++) {
      await emit(CLOUD_RING + 2 + i, mirror('chat_message', `m${i}`));
    }
    expect(count(h, 'events')).toBe(CLOUD_RING);
    expect(count(h, 'mirrors')).toBe(rows + 1);
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    let got = events(mac1);
    expect(got.filter((e) => e.startsWith('gap'))).toEqual([]);
    expect(got).toHaveLength(CLOUD_RING + rows + 1);
    // Ten more events push the oldest ten out: that is a gap, and the
    // mirror older than the ring still comes, in seq order.
    const next = CLOUD_RING + 2 + rows;
    for (let s = next; s < next + 10; s++) await emit(s, status);
    expect(count(h, 'events')).toBe(CLOUD_RING);
    expect(space(h).lost_to).toBe(11);
    events(mac1);
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    got = events(mac1);
    expect(got.slice(0, 3)).toEqual(['1 space:rs_1', 'gap2-11', '12 status']);
    expect(got.filter((e) => e.startsWith('gap'))).toHaveLength(1);
  });

  it('gaps a jump of a protocol-3 host, in history too', async () => {
    const { h, mac1, mac2, emit } = await setup();
    await emit(1, status);
    await mac2.disconnect();
    mac2.protocol = 3;
    await mac2.connect();
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 1 });
    await emit(4, status);
    expect(events(mac1)).toEqual(['gap2-3', '4 status']);
    expect(space(h).lost_to).toBe(3);
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    expect(events(mac1)).toEqual(['1 status', 'gap2-3', '4 status']);
  });

  it('never sends a mirror to a protocol-3 follower, live or history', async () => {
    const { mac1, emit } = await setup(3);
    await emit(1, status);
    await emit(2, mirror('chat_message', 'm1'));
    await emit(3, status);
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    expect(events(mac1)).toEqual(['1 status', '3 status']);
    await emit(4, mirror('space', 'rs_1'));
    await emit(5, mirror('turn_step', 'r:0'));
    await emit(6, status);
    expect(events(mac1)).toEqual(['6 status']);
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 3 });
    expect(events(mac1)).toEqual(['6 status']);
    // Nothing but mirrors after `since`: nothing at all.
    await emit(7, mirror('space', 'rs_1'));
    events(mac1);
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 6 });
    expect(events(mac1)).toEqual([]);
  });

  it('refuses a mirror of another model or a bad id', async () => {
    const { h, mac1, emit } = await setup();
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    const bad = [
      mirror('turn', 'x'),
      mirror('', 'x'),
      mirror('space', ''),
      mirror('space', 'x'.repeat(MAX_MIRROR_ID_CHARS + 1)),
      { kind: 'mirror', id: 'x' } as unknown as RemoteSpaceEvent,
      { kind: 'mirror', model: 'space', id: 7 } as unknown as RemoteSpaceEvent,
    ];
    for (const ev of bad) expect(await emit(1, ev)).toBe('fleet.invalid');
    expect(
      await emit(1, mirror('chat_message', 'm', 'x'.repeat(MAX_EVENT_BYTES))),
    ).toBe('fleet.too_large');
    expect(count(h, 'mirrors')).toBe(0);
    expect(events(mac1)).toEqual([]);
    // Nothing taken: seq 1 is still open.
    const id = 'x'.repeat(MAX_MIRROR_ID_CHARS);
    expect(await emit(1, mirror('space', id))).toBeUndefined();
    expect(events(mac1)).toEqual([`1 space:${id}`]);
  });

  it('counts mirrors in the space’s budget: the ring goes first, then fleet.busy', async () => {
    const { h, mac1, emit } = await setup();
    const reply = (turn: number): RemoteSpaceEvent => ({
      kind: 'reply',
      turn,
      text: 'x'.repeat(62_800),
    });
    for (let s = 1; s <= 20; s++) await emit(s, reply(s));
    // A replaced row counts once.
    await emit(21, bigMirror('m0'));
    await emit(22, bigMirror('m0'));
    expect(space(h).mirror_bytes).toBeLessThan(63_000);
    let seq = 23;
    let code: string | undefined;
    for (let i = 1; !code; i++) code = await emit(seq++, bigMirror(`m${i}`));
    expect(code).toBe('fleet.busy');
    const sp = space(h);
    expect(count(h, 'events')).toBe(0);
    expect(sp.bytes).toBe(0);
    expect(sp.lost_to).toBe(20);
    expect(sp.mirror_bytes).toBeLessThanOrEqual(MAX_SPACE_EVENT_BYTES);
    expect(sp.mirror_bytes + 63_000).toBeGreaterThan(MAX_SPACE_EVENT_BYTES);
    // The counter matches the rows.
    expect(
      (
        h.db
          .prepare('SELECT SUM(bytes) AS b FROM mirrors WHERE space = ?')
          .all('rs_1')[0] as { b: number }
      ).b,
    ).toBe(sp.mirror_bytes);
    // Not stored, not seen: the host resumes from the last one kept.
    expect(sp.last_seq).toBe(seq - 2);
    // A row replaced by one no bigger still fits; a tombstone frees room.
    expect(await emit(seq - 1, bigMirror('m1'))).toBeUndefined();
    expect(await emit(seq, mirror('chat_message', 'm2', null))).toBeUndefined();
    expect(await emit(seq + 1, bigMirror('m_new'))).toBeUndefined();
    // The history: the ring's loss is a gap, the rows all come.
    await mac1.send({ type: 'subscribe', space: 'rs_1', since: 0 });
    const got = events(mac1);
    expect(got[0]).toBe('gap1-20');
    expect(got.filter((e) => e.startsWith('gap'))).toHaveLength(1);
    expect(got).toHaveLength(1 + count(h, 'mirrors'));
  });

  it('counts mirrors in the user’s budget; a finished space’s go after its events', async () => {
    const { h, emit } = await setup();
    await emit(1, status);
    await emit(2, mirror('chat_message', 'm1'));
    await emit(3, mirror('chat_message', 'm2'));
    await emit(4, { kind: 'status', status: 'stopped' });
    const store = new Store({ exec: (q, ...b) => h.db.prepare(q).all(...b) });
    const sp = space(h);
    expect(store.userBytes('user_1')).toBe(sp.bytes + sp.mirror_bytes);
    expect(sp.mirror_bytes).toBeGreaterThan(0);
    const m1 = (
      h.db.prepare('SELECT bytes FROM mirrors WHERE id = ?').all('m1')[0] as {
        bytes: number;
      }
    ).bytes;
    // Wanting more than the ring holds: the oldest mirror goes too.
    expect(store.dropFinished('user_1', 'rs_other', sp.bytes + 1)).toBe(
      sp.bytes + m1,
    );
    expect(count(h, 'events')).toBe(0);
    expect(
      h.db.prepare('SELECT id FROM mirrors WHERE space = ?').all('rs_1'),
    ).toEqual([{ id: 'm2' }]);
    expect(space(h).lost_to).toBe(4);
    expect(store.userBytes('user_1')).toBe(space(h).mirror_bytes);
  });

  it('forgets a space’s mirrors with the space', async () => {
    const { h, mac1, mac2, emit } = await setup();
    await emit(1, mirror('space', 'rs_1'));
    await emit(2, mirror('chat_message', 'm1'));
    expect(count(h, 'mirrors')).toBe(2);
    await mac2.disconnect();
    await mac1.send({ type: 'remove_device', device_id: mac2.id! });
    expect(mac1.take('error')).toEqual([]);
    expect(count(h, 'mirrors')).toBe(0);
    expect(count(h, 'spaces')).toBe(0);
  });
});
