import { describe, expect, it } from 'vitest';
import {
  applyMirror,
  emptyMirror,
  type SpaceMirror,
} from '../src/fleet/mirror';
import type { SpaceView } from '../src/fleet/types';
import {
  actionablePlan,
  buildMode,
  chatView,
  composerModes,
  pairTurns,
  progressLine,
  sendMode,
} from '../src/ui/chat';
import { mockMirrors } from '../src/dev/mock';
import { foldLine, toolView, turnItems } from '../src/ui/turnRows';
import { messageMenuItems } from '../src/ui/messageMenu';
import { QUEUED_ACTIONS, queuedLabel } from '../src/ui/queued';
import type { ChatMessage, TurnStep } from '../src/fleet/contract';

const SP = 'rs_abc';
const run = (m: string) => `space:${SP}:${m}`;

const view: SpaceView = {
  space: SP,
  hostDevice: 'dev_host',
  hostName: 'Mac',
  originDevice: '',
  projectName: 'T',
  name: 'Fix',
  branch: 'b',
  status: 'running',
  mode: 'edit',
  lastReply: null,
  question: null,
  startedHere: true,
  error: null,
};

const me = (id: string, at: number, over: object = {}) => ({
  id,
  pr: `space:${SP}`,
  author: { kind: 'me' },
  text: `you ${id}`,
  at,
  ...over,
});
const agent = (id: string, at: number, of: string, over: object = {}) => ({
  id,
  pr: `space:${SP}`,
  author: { kind: 'agent', agent: 'claude' },
  text: `reply ${id}`,
  at,
  run: run(of),
  ...over,
});

function mirror(
  rows: [string, string, unknown][],
  m: SpaceMirror = emptyMirror(),
): SpaceMirror {
  return rows.reduce(
    (acc, [model, id, data]) => applyMirror(acc, SP, model, id, data),
    m,
  );
}

const space = (over: object = {}) => ({
  id: SP,
  name: 'fix',
  goal: 'Fix',
  branch: 'b',
  status: 'running',
  agent: 'claude',
  mode: 'edit',
  turns: 2,
  run: run('m3'),
  created_at: 0,
  updated_at: 0,
  ...over,
});

describe('chat view', () => {
  it('pairs your messages with their replies, the live turn last', () => {
    const m = mirror([
      ['space', SP, space()],
      ['chat_message', 'm1', me('m1', 1)],
      ['chat_message', 'm2', agent('m2', 2, 'm1')],
      ['chat_message', 'm3', me('m3', 3)],
      ['turn_step', `${run('m3')}:0`, { kind: 'text', text: 'Working' }],
      ['chat_message', 'q1', me('q1', 4, { queued: { seq: 1 } })],
    ]);
    const c = chatView(m, view);
    expect(c.turns.map((t) => t.messages.map((x) => x.id))).toEqual([
      ['m1', 'm2'],
      ['m3'],
    ]);
    expect(c.queued.map((x) => x.id)).toEqual(['q1']);
    expect(c.live).toEqual({
      run: run('m3'),
      steps: [{ kind: 'text', text: 'Working', parent: null }],
      since: 3,
    });
    // The reply lands: no live turn, the steps are gone.
    const done = mirror(
      [
        ['chat_message', 'm4', agent('m4', 5, 'm3')],
        ['space', SP, space({ status: 'idle', run: null })],
      ],
      m,
    );
    const after = chatView(done, { ...view, status: 'idle' });
    expect(after.live).toBeNull();
    expect(after.turns.at(-1)!.messages.map((x) => x.id)).toEqual(['m3', 'm4']);
  });

  it('a reply with nothing before it starts its own turn', () => {
    const turns = pairTurns([
      agent('a', 1, 'x') as unknown as ChatMessage,
      me('b', 2) as unknown as ChatMessage,
    ]);
    expect(turns.map((t) => t.key)).toEqual(['a', 'b']);
  });

  it('without a space row, live follows the newest step run while running', () => {
    const m = mirror([
      ['chat_message', 'm3', me('m3', 3)],
      ['turn_step', `${run('m3')}:0`, { kind: 'text', text: 'hi' }],
    ]);
    expect(chatView(m, view).live?.run).toBe(run('m3'));
    expect(chatView(m, { ...view, status: 'idle' }).live).toBeNull();
  });

  it('puts Approve on the last plan while the space can take a turn', () => {
    const log = [
      { message: 'm1', reply: 'm2', plan: 'old plan' },
      { message: 'm3', reply: 'm4', plan: 'the plan' },
    ];
    const idle = space({ status: 'idle', turn_log: log, build_mode: 'run' });
    const m = mirror([['space', SP, idle]]);
    const c = chatView(m, view);
    expect(c.planHere).toBe('m4');
    expect([...c.plans]).toEqual(['m2', 'm4']);
    expect(buildMode(m.space!)).toBe('run');
    expect(actionablePlan({ status: 'running', turn_log: log })).toBeNull();
    expect(
      actionablePlan({
        status: 'idle',
        turn_log: [log[0]!, { message: 'm3', reply: 'm4', undone: true }],
      }),
    ).toBe('m2');
  });

  it('marks undone turns, the question, progress and the error', () => {
    const row = space({
      status: 'running',
      turn_log: [{ message: 'm1', reply: 'm2', undone: true, steered: ['s'] }],
      question: {
        id: 'ask_1',
        run: run('m3'),
        questions: [{ question: 'Which?', options: ['A', 'B'], multi: true }],
        asked_at: 1,
      },
      progress: {
        steps: [
          { label: 'a', state: 'done' },
          { label: 'b', state: 'active' },
        ],
        at: 1,
      },
    });
    const c = chatView(mirror([['space', SP, row]]), view);
    expect([...c.undone].sort()).toEqual(['m1', 'm2', 's']);
    expect(c.question).toEqual({
      askId: 'ask_1',
      space: SP,
      from: 'Mac',
      questions: [{ question: 'Which?', options: ['A', 'B'], multi: true }],
    });
    expect(progressLine(c.progress!)).toBe('1 of 2 done');
    const failed = chatView(
      mirror([
        ['space', SP, space({ status: 'failed', error: 'worktree gone' })],
      ]),
      view,
    );
    expect(failed.error).toBe('worktree gone');
    expect(failed.progress).toBeNull();
  });

  it('names agents only when more than one replied', () => {
    const one = mirror([['chat_message', 'a', agent('a', 1, 'x')]]);
    expect(chatView(one, view).tagged).toBe(false);
    const two = mirror(
      [
        [
          'chat_message',
          'b',
          agent('b', 2, 'y', { author: { kind: 'agent', agent: 'codex' } }),
        ],
      ],
      one,
    );
    expect(chatView(two, view).tagged).toBe(true);
  });

  it('renders the mock fixture: plan with Approve, a live turn', () => {
    const idle = chatView(mockMirrors['sp-idle']!, {
      ...view,
      space: 'sp-idle',
    });
    expect(idle.planHere).toBe('m2');
    const live = chatView(mockMirrors['sp-running']!, {
      ...view,
      space: 'sp-running',
    });
    expect(live.live?.steps).toHaveLength(3);
  });
});

describe('composer', () => {
  it('offers modes up to the host cap, all when unknown', () => {
    expect(composerModes('plan')).toEqual(['ask', 'plan']);
    expect(composerModes(null)).toEqual(['ask', 'plan', 'edit', 'run']);
  });

  it("sends a mode only when it isn't the space's", () => {
    expect(sendMode('edit', 'edit')).toBeNull();
    expect(sendMode('plan', 'edit')).toBe('plan');
  });
});

describe('turn rows (the desktop rules)', () => {
  const tool = (name: string, over: object = {}): TurnStep => ({
    kind: 'tool',
    name,
    target: 'x',
    ok: true,
    ...over,
  });

  it('folds a finished turn, keeps failures and the last text', () => {
    const steps: TurnStep[] = [
      tool('Read'),
      tool('Read'),
      { kind: 'text', text: 'between' },
      tool('Edit', { added: 3, removed: 1 }),
      tool('Bash', { ok: false }),
      { kind: 'text', text: 'last' },
    ];
    const items = turnItems(steps, { pinLastText: true });
    expect(items.map((i) => i.kind)).toEqual(['fold', 'step', 'step']);
    const fold = items[0] as Extract<(typeof items)[number], { kind: 'fold' }>;
    expect(foldLine(fold.counts)).toBe('3 tool calls, 1 message');
    expect(fold.items[0]!.kind).toBe('group');
    // Running: every step its own row.
    expect(turnItems(steps, { running: true })).toHaveLength(6);
  });

  it('says what a tool row says', () => {
    expect(
      toolView(tool('Grep', { detail: 'foo', summary: '3 matches' }) as never),
    ).toMatchObject({
      label: "grep for 'foo' in x",
      note: '3 matches',
    });
    expect(toolView(tool('ask you', { ok: null }) as never, true).label).toBe(
      'Waiting for your answer',
    );
  });
});

describe('a queued bubble', () => {
  it('reads Queued, or Held with how to act on it', () => {
    expect(queuedLabel({ queued: { seq: 1 } })).toBe('Queued');
    expect(queuedLabel({ queued: { seq: 1, held: false } })).toBe('Queued');
    expect(queuedLabel({ queued: { seq: 1, held: true } })).toBe(
      'Held · hold to send or remove',
    );
  });

  it('offers Send now and Remove on a long press, Remove destructive', () => {
    const items = messageMenuItems('mine', 'later', QUEUED_ACTIONS);
    expect(items.map((a) => a.id)).toEqual([
      'copy',
      'select',
      'send_now',
      'remove',
    ]);
    expect(items.map((a) => a.label)).toEqual([
      'Copy',
      'Select text',
      'Send now',
      'Remove',
    ]);
    expect(items[3]!.destructive).toBe(true);
  });
});
