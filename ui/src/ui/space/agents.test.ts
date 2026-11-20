import { describe, expect, it } from 'vitest';
import type {
  BackgroundTask,
  ChatMessage,
  Space,
  TurnStep,
} from '../../gen/contract';
import {
  agentsHeadline,
  spaceBusy,
  subagentElapsed,
  subagentsOf,
  turnSource,
} from './agents';
import { spaceChatKey } from './spaces';

const agent = (
  id: string,
  over: Partial<Extract<TurnStep, { kind: 'tool' }>> = {},
): TurnStep => ({
  kind: 'tool',
  name: 'Agent',
  target: null,
  ok: null,
  id,
  detail: `Agent ${id}`,
  ...over,
});

const task = (over: Partial<BackgroundTask>): BackgroundTask => ({
  id: 't',
  kind: 'subagent',
  description: 'x',
  started_at: 100,
  status: 'running',
  ...over,
});

describe('subagents of a turn', () => {
  const steps: TurnStep[] = [
    { kind: 'text', text: 'Looking around.' },
    agent('a1', { ok: true }),
    {
      kind: 'tool',
      name: 'Read',
      target: 'a.rs',
      ok: true,
      id: 'r1',
      parent: 'a1',
    },
    agent('a2'),
    agent('a3', { ok: false }),
    // A subagent's own subagent stays in its row.
    agent('nested', { parent: 'a2' }),
    { kind: 'tool', name: 'Bash', target: 'ls', ok: null, id: 'b1' },
    agent('bg', { ok: true, background: true }),
  ];

  it('lists only top-level Agent/Task calls, with where each stands', () => {
    const list = subagentsOf(steps, { running: true });
    expect(list.map((a) => [a.call, a.status])).toEqual([
      ['a1', 'done'],
      ['a2', 'running'],
      ['a3', 'failed'],
      ['bg', 'background'],
    ]);
    expect(list[0]!.description).toBe('Agent a1');
  });

  it('a finished turn: done, unless its background task still runs', () => {
    const list = subagentsOf(steps, {
      running: false,
      tasks: [task({ call: 'bg', started_at: 50 })],
    });
    expect(list.map((a) => a.status)).toEqual([
      'done',
      'done',
      'failed',
      'background',
    ]);
    expect(list[3]!.startedAt).toBe(50);
    expect(subagentElapsed(list[3]!, 1050)).toBe(1000);
  });

  it('times a subagent from what this window saw, else not at all', () => {
    const list = subagentsOf([agent('a1', { ok: true }), agent('a2')], {
      running: true,
      times: (call) =>
        call === 'a1' ? { start: 10, end: 70 } : { start: 40, end: null },
    });
    expect(subagentElapsed(list[0]!, 999)).toBe(60);
    expect(subagentElapsed(list[1]!, 100)).toBe(60);
    const untimed = subagentsOf([agent('a1', { ok: true })], {
      running: false,
    });
    expect(subagentElapsed(untimed[0]!, 999)).toBeNull();
  });

  it('says it in one line', () => {
    const subs = [{ status: 'running' }, { status: 'idle' }] as Pick<
      Space,
      'status'
    >[];
    expect(agentsHeadline(subagentsOf(steps, { running: true }), subs)).toBe(
      '2 agents running · 2 sub-spaces, 1 running',
    );
    expect(agentsHeadline(subagentsOf(steps, { running: false }), [])).toBe(
      '4 agents',
    );
    expect(agentsHeadline([], [{ status: 'idle' }])).toBe('1 sub-space');
  });
});

const msg = (id: string, over: Partial<ChatMessage>): ChatMessage => ({
  id,
  pr: spaceChatKey('s'),
  author: { kind: 'me' },
  text: '',
  refs: [],
  at: 1,
  failed: null,
  ...over,
});

describe('the turn the panel reads', () => {
  const reply = (id: string, at: number, activity: TurnStep[]) =>
    msg(id, {
      author: { kind: 'agent', agent: 'claude' },
      at,
      activity,
      run: `space:s:${id}`,
    });

  it('a running turn: its live steps, in the last row', () => {
    const live = [agent('x')];
    const src = turnSource(
      { status: 'running', run: 'r9' },
      [msg('m1', { at: 1 }), reply('p1', 2, []), msg('m2', { at: 3 })],
      (run) => (run === 'r9' ? live : undefined),
      (id) => (id === 'm2' ? 'k2' : id),
    );
    expect(src).toEqual({ run: 'r9', turn: 'k2', steps: live, running: true });
  });

  it('else the last reply with steps, and the row it is in', () => {
    const steps = [agent('y', { ok: true })];
    const src = turnSource(
      { status: 'idle', run: null },
      [
        msg('m1', { at: 1 }),
        reply('p1', 2, steps),
        msg('m2', { at: 3 }),
        reply('p2', 4, []),
      ],
      () => undefined,
    );
    expect(src).toEqual({
      run: 'space:s:p1',
      turn: 'm1',
      steps,
      running: false,
    });
    expect(turnSource({ status: 'idle' }, [], () => undefined)).toBeNull();
  });
});

describe('a busy space', () => {
  const s = (id: string, over: Partial<Space> = {}): Space =>
    ({ id, status: 'idle', updated_at: 0, ...over }) as Space;

  it('a background task counts as busy, an ended one not', () => {
    expect(spaceBusy(s('a', { background_tasks: [task({})] }))).toBe(true);
    expect(
      spaceBusy(s('a', { background_tasks: [task({ status: 'completed' })] })),
    ).toBe(false);
  });
});
