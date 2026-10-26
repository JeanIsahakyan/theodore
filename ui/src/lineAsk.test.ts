/** A question asked about one diff line: pending at once, answered (or
 *  failed) when its reply lands, cleared once opened or dismissed. */
import { beforeEach, describe, expect, it } from 'vitest';
import { setTransport } from './core/transport';
import { FakeTransport } from './test/fakeTransport';
import { RootStore } from './stores/RootStore';
import { lineAskKey } from './stores/EphemeralStore';
import {
  askAboutLine,
  dismissLineAsk,
  openLineAnswer,
  replyTo,
} from './actions';
import type { Anchor, ChatMessage } from './gen/contract';

const PR = 'gh:acme/app#1';
const anchor: Anchor = {
  rev: 'h'.repeat(40),
  path: 'src/a.ts',
  side: 'new',
  line: 12,
  start_line: null,
  start_side: null,
};
const KEY = lineAskKey(PR, anchor.path, anchor.side, anchor.line);

let transport: FakeTransport;

beforeEach(() => {
  transport = new FakeTransport();
  setTransport(transport);
  transport.onCall('cancel_run', () => null);
});

function msg(
  id: string,
  at: number,
  who: 'me' | 'claude',
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    pr: PR,
    author: who === 'me' ? { kind: 'me' } : { kind: 'agent', agent: who },
    text: id,
    refs: [],
    at,
    failed: null,
    ...extra,
  };
}

const put = (store: RootStore, m: ChatMessage) =>
  store.sync.pool.put('chat_message', m.id, m);

describe('askAboutLine', () => {
  it('goes pending at once, answered on the reply, cleared once opened', async () => {
    const store = new RootStore();
    let resolve!: (id: string) => void;
    transport.onCall('ask', () => new Promise<string>((r) => (resolve = r)));

    const done = askAboutLine(store, { pr: PR, anchor, question: 'explain' });
    // Before core even answers the command: the line shows it, the panel
    // opens on the chat's bottom.
    expect(store.ephemeral.lineAsks.get(KEY)).toMatchObject({
      status: 'asking',
      agent: 'claude',
      message: null,
    });
    expect(store.ui.asideShown).toBe(true);
    expect(store.ephemeral.askFocus).toMatchObject({ pr: PR, message: null });
    expect(transport.calls.at(-1)).toMatchObject({
      cmd: 'ask',
      args: { req: { pr: PR, question: 'explain', about: anchor } },
    });

    resolve('q1');
    await done;
    expect(store.ephemeral.lineAsks.get(KEY)?.message).toBe('q1');
    expect(store.ephemeral.askFocus?.message).toBe('q1');

    put(store, msg('q1', 100, 'me', { refs: [anchor] }));
    expect(store.ephemeral.lineAsks.get(KEY)?.status).toBe('asking');
    put(store, msg('r1', 200, 'claude'));
    expect(store.ephemeral.lineAsks.get(KEY)).toMatchObject({
      status: 'answered',
      reply: 'r1',
    });

    openLineAnswer(store, KEY);
    expect(store.ephemeral.lineAsks.has(KEY)).toBe(false);
    expect(store.ephemeral.askFocus?.message).toBe('r1');
  });

  it('fails when the command fails, and Retry asks again', async () => {
    const store = new RootStore();
    transport.queueResult('ask', new Error('boom'), 'q2');
    await askAboutLine(store, { pr: PR, anchor, question: 'explain' });
    expect(store.ephemeral.lineAsks.get(KEY)?.status).toBe('failed');

    await askAboutLine(store, store.ephemeral.lineAsks.get(KEY)!);
    expect(store.ephemeral.lineAsks.get(KEY)).toMatchObject({
      status: 'asking',
      message: 'q2',
    });
  });

  it('fails on a failed reply', async () => {
    const store = new RootStore();
    transport.queueResult('ask', 'q3');
    await askAboutLine(store, { pr: PR, anchor, question: 'explain' });
    put(store, msg('q3', 100, 'me'));
    put(store, msg('r3', 200, 'claude', { failed: 'crashed' }));
    expect(store.ephemeral.lineAsks.get(KEY)?.status).toBe('failed');
  });

  it('dismissing a running ask clears it and stops its run', async () => {
    const store = new RootStore();
    transport.queueResult('ask', 'q4');
    await askAboutLine(store, { pr: PR, anchor, question: 'explain' });
    dismissLineAsk(store, KEY);
    expect(store.ephemeral.lineAsks.has(KEY)).toBe(false);
    expect(transport.calls.at(-1)).toEqual({
      cmd: 'cancel_run',
      args: { run: 'ask:q4' },
    });
    // A reply landing later doesn't bring it back.
    put(store, msg('q4', 100, 'me'));
    put(store, msg('r4', 200, 'claude'));
    expect(store.ephemeral.lineAsks.has(KEY)).toBe(false);
  });

  it('asking again while one runs only refocuses it', async () => {
    const store = new RootStore();
    transport.queueResult('ask', 'q5');
    await askAboutLine(store, { pr: PR, anchor, question: 'explain' });
    await askAboutLine(store, { pr: PR, anchor, question: 'explain' });
    expect(transport.calls.filter((c) => c.cmd === 'ask')).toHaveLength(1);
    expect(store.ephemeral.askFocus?.message).toBe('q5');
  });
});

describe('replyTo', () => {
  it('pairs each reply with the oldest open question before it', () => {
    const ms = [
      msg('a', 1, 'me'),
      msg('b', 2, 'me'),
      msg('ra', 3, 'claude'),
      msg('rb', 4, 'claude'),
    ];
    expect(replyTo(ms, 'a')?.id).toBe('ra');
    expect(replyTo(ms, 'b')?.id).toBe('rb');
    expect(replyTo(ms.slice(0, 3), 'b')).toBeNull();
  });
});
