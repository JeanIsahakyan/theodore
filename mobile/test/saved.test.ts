import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/fleet/contract';
import {
  SAVED_CHARS,
  SAVED_MAX,
  recordText,
  savedScope,
  savedSpaces,
  type SavedSpace,
} from '../src/fleet/saved';
import { memoryStorage } from '../src/keys/storage-types';

const ME = 'dev_00000000-0000-4000-8000-0000000000a1';
const HOST = 'dev_00000000-0000-4000-8000-0000000000b2';
const SCOPE = savedScope('user_1', 'org_test');

const message = (
  space: string,
  id: string,
  at: number,
  text = id,
): ChatMessage => ({
  id,
  pr: `space:${space}`,
  author: { kind: 'agent', agent: 'claude' },
  text,
  at,
  failed: null,
  attachments: [],
  queued: null,
  from_tasks: [],
  activity: [],
  duration_ms: null,
  changed_files: [],
  model: null,
  text_in_steps: false,
  run: null,
  mode: null,
});

const space = (
  id: string,
  seenAt: number,
  over: Partial<SavedSpace> = {},
): SavedSpace => ({
  view: {
    space: id,
    hostDevice: HOST,
    hostName: 'Mac Studio',
    originDevice: ME,
    projectName: 'Theodore',
    name: `Space ${id}`,
    branch: 'th/x',
    status: 'idle',
    mode: 'edit',
    lastReply: 'ok',
    question: null,
    startedHere: true,
    error: null,
  },
  lastSeq: 7,
  startedName: 'Space',
  seenAt,
  lines: [{ seq: 7, kind: 'status', text: 'idle' }],
  mirror: { space: null, messages: [message(id, 'm1', 1)] },
  ...over,
});

const ids = (list: SavedSpace[]) => list.map((s) => s.view.space);

describe('saved spaces', () => {
  it('reads back what it wrote, in list order', async () => {
    const storage = memoryStorage();
    const store = savedSpaces(storage);
    const a = space('rs_a', 1);
    const b = space('rs_b', 2, {
      view: { ...space('rs_b', 2).view, startedHere: false, status: 'waiting' },
    });
    await store.write(SCOPE, ME, [a, b], new Set(['rs_a', 'rs_b']));
    const back = await store.load(SCOPE, ME);
    expect(ids(back)).toEqual(['rs_a', 'rs_b']);
    expect(back[0]).toEqual(a);
    expect(back[1]!.view).toMatchObject({
      startedHere: false,
      status: 'waiting',
    });
    // Another account or org sees nothing of it.
    expect(await store.load(savedScope('user_1', 'org_other'), ME)).toEqual([]);
  });

  it('writes only changed records, and new ones', async () => {
    const storage = memoryStorage();
    const store = savedSpaces(storage);
    await store.write(SCOPE, ME, [space('rs_a', 1)], new Set(['rs_a']));
    const changed = space('rs_a', 3, { lastSeq: 9 });
    await store.write(SCOPE, ME, [changed, space('rs_b', 2)], new Set());
    let back = await store.load(SCOPE, ME);
    expect(back.map((s) => s.lastSeq)).toEqual([7, 7]);
    await store.write(
      SCOPE,
      ME,
      [changed, space('rs_b', 2)],
      new Set(['rs_a']),
    );
    back = await store.load(SCOPE, ME);
    expect(back.map((s) => s.lastSeq)).toEqual([9, 7]);
  });

  it(`keeps the ${SAVED_MAX} most recently active and removes the rest`, async () => {
    const storage = memoryStorage();
    const store = savedSpaces(storage);
    // List order oldest first; rs_0 was active last of all.
    const list = Array.from({ length: SAVED_MAX + 5 }, (_, i) =>
      space(`rs_${i}`, i === 0 ? 1000 : i),
    );
    await store.write(SCOPE, ME, list, new Set(ids(list)));
    const back = await store.load(SCOPE, ME);
    expect(back).toHaveLength(SAVED_MAX);
    expect(ids(back)[0]).toBe('rs_0');
    for (const gone of ['rs_1', 'rs_2', 'rs_3', 'rs_4', 'rs_5'])
      expect(ids(back)).not.toContain(gone);
    // Records of the dropped ones are removed, not left behind.
    expect(await storage.get(`theodore.fleet.space.${SCOPE}.rs_1`)).toBeNull();
    // Gone from the list: gone from storage.
    await store.write(SCOPE, ME, [list[0]!], new Set());
    expect(await storage.get(`theodore.fleet.space.${SCOPE}.rs_9`)).toBeNull();
    expect(ids(await store.load(SCOPE, ME))).toEqual(['rs_0']);
  });

  it('clears a scope', async () => {
    const storage = memoryStorage();
    const store = savedSpaces(storage);
    await store.write(SCOPE, ME, [space('rs_a', 1)], new Set(['rs_a']));
    await store.clear(SCOPE);
    expect(await storage.get(`theodore.fleet.spaces.${SCOPE}`)).toBeNull();
    expect(await storage.get(`theodore.fleet.space.${SCOPE}.rs_a`)).toBeNull();
    expect(await store.load(SCOPE, ME)).toEqual([]);
  });

  it('drops a set written for another device id, or none', async () => {
    const storage = memoryStorage();
    const store = savedSpaces(storage);
    await store.write(SCOPE, ME, [space('rs_a', 1)], new Set(['rs_a']));
    expect(await store.load(SCOPE, null)).toEqual([]);
    expect(await storage.get(`theodore.fleet.space.${SCOPE}.rs_a`)).toBeNull();
    await store.write(SCOPE, ME, [space('rs_a', 1)], new Set(['rs_a']));
    expect(await store.load(SCOPE, HOST)).toEqual([]);
    expect(await store.load(SCOPE, ME)).toEqual([]);
  });

  it('never keeps an id unfit for a file name, nor a record that is not one', async () => {
    const storage = memoryStorage();
    const store = savedSpaces(storage);
    await store.write(
      SCOPE,
      ME,
      [space('../evil', 1), space('rs_a', 2), space('rs_b', 3)],
      new Set(['../evil', 'rs_a', 'rs_b']),
    );
    await storage.set(`theodore.fleet.space.${SCOPE}.rs_b`, '{not json');
    const back = await store.load(SCOPE, ME);
    expect(ids(back)).toEqual(['rs_a']);
  });

  it('shape-checks a record read back', async () => {
    const storage = memoryStorage();
    const store = savedSpaces(storage);
    await store.write(SCOPE, ME, [space('rs_a', 1)], new Set(['rs_a']));
    const key = `theodore.fleet.space.${SCOPE}.rs_a`;
    const rec = JSON.parse((await storage.get(key))!);
    rec.view.status = 'exploded';
    rec.view.hostName = 42;
    rec.mirror.messages.push({
      id: 'x',
      pr: 'space:rs_other',
      author: { kind: 'me' },
    });
    rec.lines.push({ seq: 8, kind: 'shell', text: 'rm -rf' });
    await storage.set(key, JSON.stringify(rec));
    const [back] = await store.load(SCOPE, ME);
    expect(back!.view.status).toBe('idle');
    expect(back!.view.hostName).toBe('');
    expect(back!.mirror.messages.map((m) => m.id)).toEqual(['m1']);
    expect(back!.lines.map((l) => l.kind)).toEqual(['status']);
    // Another host's id: not a record of this space.
    rec.view.hostDevice = 'dev_evil';
    await storage.set(key, JSON.stringify(rec));
    expect(await store.load(SCOPE, ME)).toEqual([]);
  });

  it('keeps a record within its size, newest messages first', () => {
    const big = 'x'.repeat(40_000);
    const messages = Array.from({ length: 40 }, (_, i) =>
      message('rs_a', `m${i}`, i, big),
    );
    const text = recordText(
      space('rs_a', 1, { mirror: { space: null, messages } }),
    );
    expect(text.length).toBeLessThanOrEqual(SAVED_CHARS);
    const kept = (JSON.parse(text) as { mirror: { messages: ChatMessage[] } })
      .mirror.messages;
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.at(-1)!.id).toBe('m39');
  });
});
