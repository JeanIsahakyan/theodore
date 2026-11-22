import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/fleet/contract';
import type { SpaceLine } from '../src/fleet/types';
import {
  addAnswer,
  addSend,
  addStart,
  dropAnswer,
  dropSend,
  dropSends,
  resetPending,
  restoreHome,
  selectSends,
  sendFailed,
  sendRetried,
  sendSettled,
  startFailed,
  startSettled,
  takeHomeRestore,
  usePending,
} from '../src/state/pending';
import {
  MATCH_WINDOW_MS,
  answeredLabel,
  approving,
  failSend,
  isPendingId,
  matchesLine,
  matchesRow,
  newSend,
  pendingLabel,
  queuedCount,
  retrySend,
  rowOfMessage,
  rowOfSubSpaceMessage,
  settleSend,
  startLanded,
  startRefused,
  startTitle,
  startingLabel,
  unmatched,
  unmatchedByLines,
  type PendingStart,
} from '../src/ui/pending';

const T = Date.UTC(2026, 10, 21, 12, 0, 0);

const mine = (
  id: string,
  text: string,
  at = T,
  queued = false,
): ChatMessage => ({
  id,
  pr: 'space:rs_1',
  author: { kind: 'me' },
  text,
  at,
  queued: queued ? { seq: 1 } : null,
});
const theirs = (id: string, text: string, at = T): ChatMessage => ({
  id,
  pr: 'space:rs_1',
  author: { kind: 'agent', agent: 'claude' },
  text,
  at,
});

const sent = (text = 'and the tests', at = T) =>
  newSend({ key: 'k1', space: 'rs_1', text, at, afterSeq: 4 });

describe('an optimistic send', () => {
  it('starts as sending, with what a retry sends again', () => {
    const p = newSend({
      key: 'k',
      space: 'rs_1',
      text: 'go',
      at: T,
      mode: 'plan',
      picks: { model: 'opus' },
    });
    expect(p).toMatchObject({
      state: 'sending',
      position: null,
      messageId: null,
      error: null,
      kind: 'send',
      mode: 'plan',
      picks: { model: 'opus' },
      afterSeq: 0,
    });
    expect(pendingLabel(p)).toBe('Sending…');
  });

  it('the host ran it: sent, under the id its reply named', () => {
    const p = settleSend(sent(), {
      message: 'm9',
      queued: false,
      position: null,
    });
    expect(p).toMatchObject({ state: 'sent', messageId: 'm9', position: null });
    expect(pendingLabel(p)).toBe('Sent');
  });

  it('the host queued it: Queued, its place when behind others', () => {
    const q1 = settleSend(sent(), { message: 'm9', queued: true, position: 1 });
    expect(q1.state).toBe('queued');
    expect(pendingLabel(q1)).toBe('Queued');
    const q3 = settleSend(sent(), { message: null, queued: true, position: 3 });
    expect(q3.messageId).toBeNull();
    expect(pendingLabel(q3)).toBe('Queued · 3 in line');
  });

  it('refused or silent: not sent, with why; a retry sends it as new', () => {
    const f = failSend(
      settleSend(sent(), { message: null, queued: true, position: 2 }),
      "the other device didn't answer in time",
    );
    expect(f).toMatchObject({
      state: 'failed',
      position: null,
      error: "the other device didn't answer in time",
    });
    expect(pendingLabel(f)).toBe('Not sent');
    const again = retrySend(f, T + 10_000);
    expect(again).toMatchObject({
      state: 'sending',
      at: T + 10_000,
      error: null,
      messageId: null,
      position: null,
      text: 'and the tests',
    });
  });
});

describe('a mirrored row replaces the bubble', () => {
  it('by the id the host named, whatever the text or time', () => {
    const p = settleSend(sent(), {
      message: 'm9',
      queued: false,
      position: null,
    });
    expect(
      matchesRow(p, rowOfMessage(mine('m9', 'edited', T + 3_600_000))),
    ).toBe(true);
    expect(matchesRow(p, rowOfMessage(mine('m8', 'and the tests')))).toBe(
      false,
    );
  });

  it('else by the text, close in time on the two clocks', () => {
    const p = sent();
    expect(
      matchesRow(p, rowOfMessage(mine('x', 'and the tests', T + 5_000))),
    ).toBe(true);
    expect(
      matchesRow(p, rowOfMessage(mine('x', ' and the tests ', T - 30_000))),
    ).toBe(true);
    expect(
      matchesRow(
        p,
        rowOfMessage(mine('x', 'and the tests', T + MATCH_WINDOW_MS + 1)),
      ),
    ).toBe(false);
    expect(matchesRow(p, rowOfMessage(mine('x', 'and the docs')))).toBe(false);
  });

  it('never an agent’s row, never a failed send', () => {
    expect(matchesRow(sent(), rowOfMessage(theirs('a', 'and the tests')))).toBe(
      false,
    );
    const f = failSend(sent(), 'refused');
    expect(matchesRow(f, rowOfMessage(mine('x', 'and the tests')))).toBe(false);
  });

  it('a row named by id is not taken by a text match of another bubble', () => {
    const named = settleSend(sent(), {
      message: 'm9',
      queued: false,
      position: null,
    });
    expect(
      matchesRow(named, rowOfMessage(mine('other', 'and the tests'))),
    ).toBe(false);
    const unnamed = sent();
    // A host that names no ids: text and time decide.
    expect(
      matchesRow(unnamed, rowOfMessage(mine('other', 'and the tests'))),
    ).toBe(true);
  });

  it('a queued mirrored row stands for a queued bubble', () => {
    const q = settleSend(sent(), { message: 'q1', queued: true, position: 1 });
    const left = unmatched(
      [q],
      [rowOfMessage(mine('q1', 'and the tests', T, true))],
    );
    expect(left).toEqual([]);
  });

  it('a row takes one bubble: two sends of the same text, one row ─▶ one stays', () => {
    const a = sent('again', T);
    const b = { ...sent('again', T + 1000), key: 'k2' };
    const left = unmatched(
      [a, b],
      [rowOfMessage(mine('r1', 'again', T + 500))],
    );
    expect(left.map((p) => p.key)).toEqual(['k2']);
    const none = unmatched(
      [a, b],
      [
        rowOfMessage(mine('r1', 'again', T + 500)),
        rowOfMessage(mine('r2', 'again', T + 1500)),
      ],
    );
    expect(none).toEqual([]);
  });

  it('a sub-space’s read message of yours stands for one; its parent agent’s does not', () => {
    const p = sent('go on');
    expect(
      matchesRow(
        p,
        rowOfSubSpaceMessage({
          from: 'user',
          at: T + 1000,
          text: 'go on',
          truncated: false,
        }),
      ),
    ).toBe(true);
    expect(
      matchesRow(
        p,
        rowOfSubSpaceMessage({
          from: 'space:abc',
          at: T + 1000,
          text: 'go on',
          truncated: false,
        }),
      ),
    ).toBe(false);
  });
});

describe('a host that mirrors no rows: a "Turn n" line stands for it', () => {
  const line = (
    seq: number,
    text: string,
    kind: SpaceLine['kind'] = 'turn',
  ) => ({
    seq,
    kind,
    text,
  });

  it('a turn line past the send, with its text', () => {
    const p = sent();
    expect(matchesLine(p, line(5, 'Turn 3: and the tests'))).toBe(true);
    expect(matchesLine(p, line(4, 'Turn 3: and the tests'))).toBe(false);
    expect(matchesLine(p, line(5, 'Turn 3: and the docs'))).toBe(false);
    expect(matchesLine(p, line(5, 'and the tests', 'reply'))).toBe(false);
    expect(
      matchesLine(failSend(p, 'x'), line(5, 'Turn 3: and the tests')),
    ).toBe(false);
  });

  it('a long message is cut in the line; the start of it is enough', () => {
    const long = 'x'.repeat(2500);
    const p = sent(long);
    expect(matchesLine(p, line(9, `Turn 1: ${'x'.repeat(2000)}`))).toBe(true);
    expect(matchesLine(p, line(9, `Turn 1: ${'x'.repeat(1999)}y`))).toBe(false);
  });

  it('unmatchedByLines keeps what no line stands for', () => {
    const a = sent('one');
    const b = { ...sent('two'), key: 'k2' };
    expect(
      unmatchedByLines(
        [a, b],
        [line(5, 'Turn 1: one'), line(6, 'Run tests', 'tool')],
      ).map((p) => p.key),
    ).toEqual(['k2']);
  });
});

describe('what the strip and the plan actions read', () => {
  it('counts the queue: queued, and sending while the space runs', () => {
    const s = sent();
    const q = settleSend(sent(), { message: null, queued: true, position: 1 });
    const done = settleSend(sent(), {
      message: 'm',
      queued: false,
      position: null,
    });
    const f = failSend(sent(), 'no');
    expect(queuedCount([s, q, done, f], true)).toBe(2);
    expect(queuedCount([s, q, done, f], false)).toBe(1);
  });

  it('Approve is busy while its bubble is sending', () => {
    const a = {
      ...sent('Plan approved, implement it.'),
      kind: 'approve' as const,
    };
    expect(approving([a])).toBe(true);
    expect(
      approving([
        settleSend(a, { message: 'm', queued: false, position: null }),
      ]),
    ).toBe(false);
    expect(approving([sent()])).toBe(false);
  });
});

describe('a start from Home', () => {
  const start: PendingStart = {
    id: 'pending_1',
    deviceId: 'dev_a',
    hostName: 'mac-A',
    projectId: 'p1',
    projectName: 'theodore',
    goal: 'Fix the login redirect.\nIt loops on /callback.',
    mode: 'edit',
    picks: {},
    at: T,
    state: 'starting',
    space: null,
    error: null,
  };

  it('is told apart from a space by its route id', () => {
    expect(isPendingId('pending_abc_1')).toBe(true);
    expect(isPendingId('rs_abc')).toBe(false);
  });

  it('shows the goal’s first line and where it starts', () => {
    expect(startTitle(start.goal)).toBe('Fix the login redirect');
    expect(startTitle('   \n\n')).toBe('New space');
    expect(startTitle(`${'word '.repeat(20)}end`)).toMatch(/…$/);
    expect(startingLabel('mac-A')).toBe('Starting on mac-A…');
  });

  it('lands on the real space, or is refused with why', () => {
    expect(startLanded(start, 'rs_9')).toMatchObject({
      state: 'starting',
      space: 'rs_9',
      error: null,
    });
    expect(
      startRefused(start, 'the other device refused: fleet.busy'),
    ).toMatchObject({
      state: 'failed',
      space: null,
      error: 'the other device refused: fleet.busy',
    });
  });
});

describe('an answer, as the card shows it at once', () => {
  it('names the options picked and the free text, per question', () => {
    expect(answeredLabel([{ selected: ['SQLite'], other: '' }])).toBe(
      'Answered: SQLite',
    );
    expect(
      answeredLabel([
        { selected: ['a', 'b'], other: ' and c ' },
        { selected: [], other: 'free' },
      ]),
    ).toBe('Answered: a, b, and c · free');
    expect(answeredLabel([{ selected: [], other: 'x'.repeat(200) }])).toBe(
      `Answered: ${'x'.repeat(119)}…`,
    );
  });
});

describe('the pending store', () => {
  beforeEach(() => resetPending());

  it('a send is added, settled, failed, retried and dropped by key', () => {
    const key = addSend({ space: 'rs_1', text: 'go', at: T });
    expect(selectSends('rs_1')(usePending.getState())).toHaveLength(1);
    sendSettled('rs_1', key, { message: 'm1', queued: true, position: 2 });
    expect(selectSends('rs_1')(usePending.getState())[0]).toMatchObject({
      state: 'queued',
      position: 2,
      messageId: 'm1',
    });
    sendFailed('rs_1', key, 'refused');
    expect(selectSends('rs_1')(usePending.getState())[0]!.state).toBe('failed');
    const again = sendRetried('rs_1', key);
    expect(again?.state).toBe('sending');
    expect(again?.text).toBe('go');
    dropSend('rs_1', key);
    expect(usePending.getState().sends).toEqual({});
    // Gone: nothing to settle, nothing to retry.
    sendSettled('rs_1', key, { message: null, queued: false, position: null });
    expect(sendRetried('rs_1', key)).toBeNull();
    expect(usePending.getState().sends).toEqual({});
  });

  it('keeps sends per space, oldest first, and drops several at once', () => {
    const a = addSend({ space: 'rs_1', text: 'a', at: T });
    const b = addSend({ space: 'rs_1', text: 'b', at: T + 1 });
    addSend({ space: 'rs_2', text: 'c', at: T + 2 });
    expect(
      selectSends('rs_1')(usePending.getState()).map((p) => p.text),
    ).toEqual(['a', 'b']);
    dropSends('rs_1', [a, b]);
    expect(selectSends('rs_1')(usePending.getState())).toEqual([]);
    expect(selectSends('rs_2')(usePending.getState())).toHaveLength(1);
    // The same empty list every time: a stable selector result.
    expect(selectSends('rs_1')(usePending.getState())).toBe(
      selectSends('rs_3')(usePending.getState()),
    );
  });

  it('a start gets a pending id, lands on the real space or fails; settled ones are forgotten by the next', () => {
    const base = {
      deviceId: 'dev_a',
      hostName: 'mac-A',
      projectId: 'p1',
      projectName: 'theodore',
      goal: 'Fix it',
      mode: 'edit' as const,
      picks: {},
    };
    const id = addStart(base);
    expect(isPendingId(id)).toBe(true);
    expect(usePending.getState().starts[id]).toMatchObject({
      state: 'starting',
      space: null,
      hostName: 'mac-A',
    });
    startSettled(id, 'rs_9');
    expect(usePending.getState().starts[id]!.space).toBe('rs_9');

    const other = addStart({ ...base, goal: 'Another' });
    expect(usePending.getState().starts[id]).toBeUndefined();
    startFailed(other, 'fleet.busy');
    expect(usePending.getState().starts[other]).toMatchObject({
      state: 'failed',
      error: 'fleet.busy',
    });
    // Unknown ids change nothing.
    startSettled('pending_none', 'rs_1');
    startFailed('pending_none', 'x');
    expect(Object.keys(usePending.getState().starts)).toEqual([other]);
  });

  it('a refused start’s goal and error wait for Home, once', () => {
    expect(takeHomeRestore()).toBeNull();
    restoreHome('Fix it', 'fleet.busy');
    expect(usePending.getState().homeRestore).toEqual({
      goal: 'Fix it',
      error: 'fleet.busy',
    });
    expect(takeHomeRestore()).toEqual({ goal: 'Fix it', error: 'fleet.busy' });
    expect(takeHomeRestore()).toBeNull();
  });

  it('an answer is shown as given until dropped (a refusal)', () => {
    addAnswer('ask1', 'rs_1', 'Answered: SQLite');
    expect(usePending.getState().answers.ask1).toMatchObject({
      space: 'rs_1',
      label: 'Answered: SQLite',
    });
    dropAnswer('ask1');
    dropAnswer('ask1');
    expect(usePending.getState().answers).toEqual({});
  });
});
